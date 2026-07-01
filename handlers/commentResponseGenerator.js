import {
  getRelevantContextFromPgvector,
} from './embedding.js';
import {
  getCommentThread,
  getPostDetails,
  getPostImageDescription,
  updatePostImageDescription,
} from '../lib/database.js';
import {
  openai,
  responseSchema,
  describeImage,
  describeVideo,
  detectMediaType,
  isCrosspostUrl,
  fetchCrosspostContent,
  searchGiphy,
  selectBestGif,
} from './aiHelpers.js';
import fs from 'fs';
import pkg from 'jsonschema';
import fetch from 'node-fetch';
import chalk from 'chalk';

const { Validator } = pkg;

async function buildCommentTree(commentId, postId) {
  const thread = await getCommentThread(commentId, postId);
  const commentMap = new Map();
  thread.forEach((c) => {
    commentMap.set(c.id, c);
  });
  const result = [];
  let currentComment = commentMap.get(commentId);

  while (currentComment) {
    const isBot =
      currentComment.author === (process.env.REDDIT_USERNAME || 'AskNITJ');
    result.unshift({
      role: isBot ? 'assistant' : 'user',
      content: isBot
        ? currentComment.body
        : `[Author: u/${currentComment.author}] ${currentComment.body}`,
    });
    currentComment = commentMap.get(currentComment.parent_id);
  }

  return result;
}

async function generateCommentResponse(
  comment,
  post,
  userOverview = null,
  instructions = '',
) {
  const systemInstruction = fs.readFileSync(
    './assets/systemInstruction.txt',
    'utf-8',
  );
  const postTitle = post.title || 'No Title';
  let postBody = post.selftext || post.body || '';
  let imageUrl = post.post_hint === 'image' ? post.url : null;
  let videoUrl =
    post.is_video || post.post_hint === 'hosted:video' ? post.video_url : null;

  if (!postBody && isCrosspostUrl(post.url)) {
    try {
      console.log(
        chalk.cyan('[COMMENT]') + ` [${comment.id}] Crosspost detected on parent post, fetching original content...`,
      );
      const original = await fetchCrosspostContent(post.url);
      if (original) {
        const parts = [];
        const originInfo = original.subreddit
          ? ` from r/${original.subreddit}`
          : '';
        if (original.title && original.title !== post.title) {
          parts.push(
            `[Crossposted${originInfo} — Original Title: "${original.title}"]`,
          );
        } else {
          parts.push(`[Crossposted${originInfo}]`);
        }
        if (original.selftext) parts.push(original.selftext);
        postBody = parts.join('\n');
        if (!imageUrl && !videoUrl && original.url) {
          if (original.post_hint === 'image') {
            imageUrl = original.url;
          } else if (
            original.is_video ||
            original.post_hint === 'hosted:video'
          ) {
            videoUrl = original.video_url || null;
          } else {
            const mt = detectMediaType(original.url);
            if (mt === 'image') imageUrl = original.url;
            else if (mt === 'video') {
              videoUrl = /^https?:\/\/v\.redd\.it\//i.test(original.url)
                ? `${original.url.replace(/\/$/, '')}/CMAF_360.mp4?source=fallback`
                : original.url;
            }
          }
        }
      }
    } catch (err) {
      console.warn(
        chalk.red('[ERROR]') + ` [COMMENT ${comment.id}] Failed to fetch crosspost content: ${err.message}`,
      );
    }
  }

  if (!imageUrl && !videoUrl) {
    const mediaType = detectMediaType(post.url);
    if (mediaType === 'image') {
      imageUrl = post.url;
    } else if (mediaType === 'video') {
      videoUrl = /^https?:\/\/v\.redd\.it\//i.test(post.url)
        ? `${post.url.replace(/\/$/, '')}/CMAF_360.mp4?source=fallback`
        : post.url;
    }
  }

  let imageDescription = post.image_description || '';
  if (!imageDescription) {
    imageDescription = (await getPostImageDescription(post.id)) || '';
  }

  if (!imageDescription && imageUrl) {
    try {
      const image = await fetch(imageUrl);
      if (image.ok) {
        const mimeType = image.headers.get('Content-Type') || 'image/png';
        const imageData = Buffer.from(await image.arrayBuffer()).toString(
          'base64',
        );
        imageDescription = await describeImage(imageData, mimeType);
        if (imageDescription) {
          await updatePostImageDescription(post.id, imageDescription);
        }
      }
    } catch (error) {
      console.error(
        chalk.red('[ERROR]') + ` [COMMENT ${comment.id}] Error fetching/describing image:`,
        error.message,
      );
      imageUrl = null;
    }
  }

  if (!imageDescription && videoUrl) {
    try {
      imageDescription = await describeVideo(videoUrl);
      if (imageDescription) {
        await updatePostImageDescription(post.id, imageDescription);
      }
    } catch (error) {
      console.error(
        chalk.red('[ERROR]') + ` [COMMENT ${comment.id}] Error describing video:`,
        error.message,
      );
      videoUrl = null;
    }
  }

  const commentTree = await buildCommentTree(comment.id, comment.post_id);

  const commentEmbeddings = await getRelevantContextFromPgvector(
    commentTree[0].content,
    false,
  );
  const postEmbeddings = await getRelevantContextFromPgvector(
    `${postTitle}\n${postBody}`,
    false,
  );

  const postContext = {
    role: 'system',
    content: `[POST AUTHOR] u/${post.author}
    [POST TITLE] ${postTitle}
    [POST BODY] ${postBody}
    ${imageUrl ? `Post Image URL: ${imageUrl}` : ''}
    ${imageDescription ? `Post Media Description: ${imageDescription}` : ''}
    ${videoUrl ? `Video URL: ${videoUrl}` : ''}`,
  };

  const postEmbeddingContext = {
    role: 'system',
    content: `[POST EMBEDDINGS] ${postEmbeddings}`,
  };

  const commentEmbeddingContext = {
    role: 'system',
    content: `[COMMENT EMBEDDINGS] ${commentEmbeddings}`,
  };

  const messages = [
    {
      role: 'system',
      content: systemInstruction,
    },
    postContext,
    postEmbeddingContext,
    commentEmbeddingContext,
  ];

  if (userOverview) {
    messages.push({
      role: 'system',
      content: `[USER PROFILE OVERVIEW FOR u/${userOverview.username}]
${userOverview.data}`,
    });
  }

  if (instructions) {
    messages.push({
      role: 'system',
      content: `[INSTRUCTIONS] ${instructions}`,
    });
  }

  messages.push(...commentTree);

  let actionInstructions = `Keep the persona guidelines in mind and output a valid JSON matching the schema: { "action": "reply" | "query_user" | "reply_with_gif" | "dont_reply", "text": string, "gif_search_query": string }.
- If the commenter is asking about themselves, complaining, boasting, or arguing, select "query_user" and set "text" to their username (e.g. "${comment.author}") to lookup their profile. Do NOT query yourself.
- If a GIF fits the tone (e.g. jokes, memes, celebration), select "reply_with_gif" and set "gif_search_query" to search Giphy.`;

  if (userOverview) {
    actionInstructions += `\n- Since [USER PROFILE OVERVIEW FOR u/${userOverview.username}] is provided, you MUST construct a personalized, sarcastic reply/roast referencing details from their posting history (e.g. subreddits they visit, topics they discuss) in a witty bhaiya style. End with /s. Select "reply" or "reply_with_gif".`;
  }

  messages.push({
    role: 'system',
    content: `=== FINAL INSTRUCTIONS ===
Please generate a response for the last comment in the thread.
${actionInstructions}`,
  });

  const primaryModel =
    process.env.GENERATION_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b';
  const fallbackModel =
    process.env.FALLBACK_GENERATION_MODEL || 'meta/llama-3.1-70b-instruct';
  let retries = 3;
  let content = null;

  while (retries > 0) {
    const currentModel = retries === 1 ? fallbackModel : primaryModel;
    try {
      console.log(
        chalk.cyan('[COMMENT]') + ` [${comment.id}] Requesting completion using model ${currentModel}...`,
      );
      const response = await openai.chat.completions.create({
        model: currentModel,
        messages: messages,
        response_format: { type: 'json_object' },
        temperature: 0.7,
      });

      content = response.choices[0].message.content.trim();
      console.log(chalk.cyan('[COMMENT]') + ` [${comment.id}] Raw response: ${content}`);

      let responseData;
      try {
        responseData = JSON.parse(content);
      } catch (parseError) {
        console.error(
          chalk.red('[ERROR]') + ` Retry ${4 - retries} failed: Invalid JSON - ${parseError.message}`,
        );
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (responseData.action === 'dont_reply') {
        return { action: 'dont_reply', text: '' };
      }

      const validator = new Validator();
      const validationResult = validator.validate(responseData, responseSchema);
      if (!validationResult.valid) {
        console.error(
          chalk.red('[ERROR]') + ` Schema validation failed for comment ${comment.id}:`,
          validationResult.errors,
        );
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (
        responseData.action === 'reply' ||
        responseData.action === 'reply_with_gif'
      ) {
        if (responseData.action === 'reply_with_gif') {
          const gifQuery = responseData.gif_search_query || 'meme';
          console.log(chalk.cyan('[COMMENT]') + ` Searching Giphy for: "${gifQuery}"`);
          const candidates = await searchGiphy(gifQuery);
          if (candidates.length > 0) {
            const choice = await selectBestGif(
              postTitle,
              postBody,
              responseData.text,
              candidates.slice(0, 8),
              currentModel,
            );
            if (choice && choice >= 1 && choice <= candidates.length) {
              const selectedGif = candidates[choice - 1];
              responseData.text = `${responseData.text}\n\n![gif](${selectedGif.url})`;
            }
          }
        }

        return {
          action: 'reply',
          text: `${responseData.text}\n\n*I'm a bot*⋆.˚ ᡣ𐭩 .𖥔˚`,
        };
      } else if (responseData.action === 'query_user') {
        return responseData;
      }

      retries--;
    } catch (err) {
      console.error(chalk.red('[ERROR]') + ` Retry ${4 - retries} failed with error:`, err.message);
      retries--;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return { action: 'dont_reply', text: '' };
}

export { generateCommentResponse };
