import OpenAI from 'openai';
import {
  getRelevantContextFromPgvector,
  validateResponseContent,
} from './embedding.js';
import fs from 'fs';
import pkg from 'jsonschema';
import { execSync } from 'child_process';
import path from 'path';
const { Validator } = pkg;
import chalk from 'chalk';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

const responseSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reply', 'query_user', 'reply_with_gif'] },
    text: { type: 'string' },
    gif_search_query: { type: 'string' },
  },
  required: ['action', 'text'],
};

async function describeImage(base64Data, mimeType) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return '';
  
  const visionModel = 'qwen/qwen3.5-397b-a17b';
  try {
    console.log(`[VISION] Describing post image using ${visionModel}...`);
    const content = [
      {
        type: 'text',
        text: 'Analyze the visual content of this image in detail. Focus on text, humor, mood, and objects. Return only the description without any conversational filler.'
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Data}`
        }
      }
    ];

    const response = await openai.chat.completions.create({
      model: visionModel,
      messages: [{ role: 'user', content: content }],
      temperature: 0.2,
      max_tokens: 300,
    });

    const description = response.choices[0].message.content.trim();
    console.log(`[VISION] Image description: "${description.slice(0, 150)}..."`);
    return description;
  } catch (error) {
    console.error(`[VISION] Failed to describe image:`, error.message);
    return '';
  }
}

function getFfmpegPath() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (sysErr) {
    console.error('[VISION] System ffmpeg not found in PATH.');
    return 'ffmpeg';
  }
}

function getFfprobePath() {
  try {
    execSync('ffprobe -version', { stdio: 'ignore' });
    return 'ffprobe';
  } catch (sysErr) {
    console.error('[VISION] System ffprobe not found in PATH.');
    return 'ffprobe';
  }
}

async function describeVideo(videoUrl) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return '';

  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();

  const tempDir = path.join(process.cwd(), 'scratch', `video_temp_${Date.now()}`);
  try {
    fs.mkdirSync(tempDir, { recursive: true });

    let duration = 10;
    try {
      const durationStr = execSync(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoUrl}"`).toString().trim();
      const parsedDuration = parseFloat(durationStr);
      if (!isNaN(parsedDuration) && parsedDuration > 0) {
        duration = parsedDuration;
        console.log(`[VISION] Video duration: ${duration}s`);
      }
    } catch (ffprobeErr) {
      console.warn(`[VISION] Failed to probe video duration:`, ffprobeErr.message);
    }

    const fps = (5 / duration).toFixed(4);
    console.log(`[VISION] Extracting frames from video URL: ${videoUrl} with fps=${fps}`);
    const outputPattern = path.join(tempDir, 'frame_%03d.jpg');
    execSync(`"${ffmpegPath}" -y -i "${videoUrl}" -vf "fps=${fps}" -vframes 5 "${outputPattern}"`, { stdio: 'ignore' });

    const files = fs.readdirSync(tempDir).filter(file => file.endsWith('.jpg')).sort();
    if (files.length === 0) {
      console.log('[VISION] No frames extracted from video.');
      return '';
    }

    console.log(`[VISION] Describing video using ${files.length} extracted frames...`);

    const content = [
      {
        type: 'text',
        text: 'These are sequential keyframes from a video post on Reddit. Analyze the visual content, actions, text overlay, humor, and story shown across these frames in detail. Return a detailed, single description of the video.'
      }
    ];

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const base64Data = fs.readFileSync(filePath).toString('base64');
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${base64Data}`
        }
      });
    }

    const response = await openai.chat.completions.create({
      model: 'qwen/qwen3.5-397b-a17b',
      messages: [{ role: 'user', content: content }],
      temperature: 0.2,
      max_tokens: 350,
    });

    const description = response.choices[0].message.content.trim();
    console.log(`[VISION] Video description: "${description.slice(0, 150)}..."`);
    return description;
  } catch (error) {
    console.error(`[VISION] Failed to describe video:`, error.message);
    return '';
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error(`[VISION] Failed to clean up temp dir:`, cleanupError.message);
    }
  }
}

async function generateResponse(
  item,
  isDM = false,
  isComment = false,
  additionalContext = '',
) {
  let systemInstructionPath = './assets/systemInstruction.txt';
  let systemInstruction = fs.readFileSync(systemInstructionPath, 'utf-8');
  let title = isDM ? 'Direct Message' : item.title;
  let contentText = isDM ? item.body : item.selftext || '';
  let imageUrl = !isDM && item.post_hint === 'image' ? item.url : null;
  let mimeType = 'image/png';
  let imageData = null;

  if (imageUrl) {
    try {
      const image = await fetch(imageUrl);
      mimeType = image.headers.get('Content-Type') || 'image/png';
      imageData = Buffer.from(await image.arrayBuffer()).toString('base64');
    } catch (error) {
      console.error(
        `[${isDM ? 'DM' : 'POST'} ${item.id}] Error fetching image:`,
        error.message,
      );
      imageUrl = null;
    }
  }

  let contextText = await getRelevantContextFromPgvector(item, isDM);
  console.log(
    `[${isDM ? 'DM' : 'POST'} ${item.id}] Context fetched successfully`
  );
  console.log(`[${isDM ? 'DM' : 'POST'} ${item.id}] Context: ${contextText.slice(0, 200)}...`);

  if (contextText === 'No context available') {
    console.log(
      `[${isDM ? 'DM' : 'POST'} ${item.id}] No specific past comments found, using default base wiki context.`
    );
    contextText =
      'No specific past comments found. Answer using general college knowledge and wiki context.';
  }

  
  let imageDescription = '';
  if (imageData) {
    imageDescription = await describeImage(imageData, mimeType);
  }

  let videoUrl = !isDM && (item.is_video || item.post_hint === 'hosted:video') ? item.video_url : null;
  let videoDescription = '';
  if (videoUrl) {
    videoDescription = await describeVideo(videoUrl);
  }

  try {
    console.log(
      `[${isDM ? 'DM' : 'POST'} ${item.id}] Generating response: ${title}`
    );
    let retries = 3;
    let content = null;
    while (retries > 0) {
      if (!process.env.NVIDIA_API_KEY) {
        console.error(
          `NVIDIA_API_KEY is not defined in the environment variables`,
        );
        return { action: 'reply', text: '0canthelpwiththisquery0' };
      }

      try {
        if (isComment) {
          contextText = '';
        }
        const prompt = `You must respond with a valid JSON object matching the schema: { "action": "reply" | "query_user" | "reply_with_gif", "text": string, "gif_search_query": string }. 
For "reply", provide a concise (2-3 lines max), factual, but highly sarcastic, dank, and funny Hinglish reply (Hindi in Latin script) as a senior bhaiya, using the context. Never reply in plain English or standard AI tone. Be human, witty, and reference local lore if it fits. For Production Engineering, focus on core vs tech roles.
For "reply_with_gif", write your Hinglish reply in "text", and provide a short, descriptive search query (e.g. "facepalm" or "screaming cat") in "gif_search_query". Use this when a visual meme/GIF would heavily amplify the sarcasm, roast, or humor of your reply.
For "query_user", return the username (without "u/") for user-specific queries (e.g., roasts or "who is"). 
If unanswerable, return { "action": "reply", "text": "0canthelpwiththisquery0" }. Do not return plain text or invalid JSON. Do not mention any attached placement stats image.
-----------------
        This is the actual query of user.:
Post Title: ${title}
Post Content: ${contentText}
Image URL: ${imageUrl || 'No image provided'}
${imageDescription ? `Post Image Visual Content Description: ${imageDescription}` : ''}
${videoUrl ? `Video URL: ${videoUrl}` : ''}
${videoDescription ? `Post Video Visual Content Description (sequence of keyframes): ${videoDescription}` : ''}
-----------------
Use below mentioned data only for context and nothing else. Do not answer the questions below, It is for the information retrieval. Only answer the actual query of user in your response which is mentioned above. Again, Do not mention any of the context data in your response. Do not assume the belowmentioned to be part of query, but only the information that may or may not help your generate the actual response:
Subreddit Context (Top Comments):
${contextText}
Additional Context:
${additionalContext}`;

        console.log(chalk.green(`\n=== PROMPT FOR [${isDM ? 'DM' : 'POST'} ${item.id}] ===\n${prompt}\n`));

        const modelName =
          process.env.GENERATION_MODEL || 'qwen/qwen3.5-122b-a10b';

        const messages = [
          {
            role: 'system',
            content: systemInstruction,
          },
          {
            role: 'user',
            content: prompt,
          },
        ];

        const response = await openai.chat.completions.create({
          model: modelName,
          messages: messages,
          response_format: { type: 'json_object' },
          temperature: 0.7,
        });

        content = response.choices[0].message.content.trim();
        console.log(
          `Raw model response for ${isDM ? 'message' : 'post'} ${item.id}:`,
          content,
        );

        let responseData;
        try {
          responseData = JSON.parse(content);
        } catch (parseError) {
          console.error(
            `Retry ${4 - retries} failed: Invalid JSON - ${parseError.message}`,
          );
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (
          (responseData.action === 'reply' ||
            responseData.action === 'reply_with_gif') &&
          responseData.text.includes('0canthelpwiththisquery0')
        ) {
          return { action: 'reply', text: '0canthelpwiththisquery0' };
        }

        const validator = new Validator();
        const validationResult = validator.validate(
          responseData,
          responseSchema,
        );
        if (!validationResult.valid) {
          console.error(
            `Schema validation failed for ${isDM ? 'message' : 'post'} ${item.id}:`,
            validationResult.errors,
          );
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (
          (responseData.action === 'reply' ||
            responseData.action === 'reply_with_gif') &&
          responseData.text &&
          responseData.text.trim()
        ) {
          try {
            const validation = await validateResponseContent(responseData.text);
            console.log(
              `Validation check for ${isDM ? 'message' : 'post'} ${item.id}: Reliable=${validation.isReliable}, CommentCount=${validation.commentCount}`,
            );
          } catch (valErr) {
            console.warn(`Validation check failed/skipped:`, valErr.message);
          }

          if (responseData.action === 'reply_with_gif') {
            const query = responseData.gif_search_query || 'meme';
            console.log(`Searching Giphy for query: "${query}"`);
            const candidates = await searchGiphy(query);
            if (candidates.length > 0) {
              console.log(
                `Found ${candidates.length} GIF candidates. Asking LLM to choose the best fit...`,
              );
              const choice = await selectBestGif(
                title,
                contentText,
                responseData.text,
                candidates.slice(0, 8),
                modelName,
              );
              if (choice && choice >= 1 && choice <= candidates.length) {
                const selectedGif = candidates[choice - 1];
                console.log(
                  `Selected GIF candidate #${choice}: "${selectedGif.title}" (${selectedGif.url})`,
                );
                responseData.text = `${responseData.text}\n\n![gif](${selectedGif.url})`;
              } else {
                console.log(
                  'LLM decided not to attach any of the GIF candidates.',
                );
              }
            } else {
              console.log(`No Giphy results found for query: "${query}"`);
            }
          }

          return {
            action: 'reply',
            text: `${responseData.text}\n\n*I'm a bot*⋆.˚ ᡣ𐭩 .𖥔˚`,
          };
        } else if (responseData.action === 'query_user') {
          return responseData;
        }

        console.log(`Invalid or empty response, retries left: ${retries}`);
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Retry ${4 - retries} failed:`, error.message);
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(
      `No valid response generated after retries for ${isDM ? 'message' : 'post'} ${item.id}`,
    );
    return { action: 'reply', text: '0canthelpwiththisquery0' };
  } catch (error) {
    console.error(
      `Error generating response for ${isDM ? 'message' : 'post'} ${item.id}:`,
      error.message,
    );
    return { action: 'reply', text: '0canthelpwiththisquery0' };
  }
}

async function fetchImageBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/png';
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return { contentType, base64 };
  } catch (error) {
    console.error(`[GIF FETCH] Failed to fetch still image from ${url}:`, error.message);
    return null;
  }
}

async function searchGiphy(query) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    console.warn("[GIF WARN] GIPHY_API_KEY is not defined in the environment variables. Skipping GIF search.");
    return [];
  }
  
  let cleanedQuery = query;
  if (query.includes('giphy.com/')) {
    try {
      const urlObj = new URL(query);
      const pathname = urlObj.pathname;
      const parts = pathname.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1];
      if (lastPart) {
        cleanedQuery = decodeURIComponent(lastPart);
      }
    } catch (e) {
      const parts = query.split('/');
      const lastPart = parts[parts.length - 1] || parts[parts.length - 2];
      if (lastPart) {
        cleanedQuery = lastPart;
      }
    }
  }

  
  cleanedQuery = cleanedQuery.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  
  if (cleanedQuery !== query) {
    console.log(`[GIF SEARCH] Cleaned search query: "${query}" -> "${cleanedQuery}"`);
  }
  
  const fetchGifs = async (q) => {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(q)}&limit=8&rating=pg-13`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Giphy API error: ${response.statusText}`);
    }
    const json = await response.json();
    return json.data || [];
  };

  try {
    let data = await fetchGifs(cleanedQuery);
    
    
    if (data.length === 0 && cleanedQuery.trim().includes(' ')) {
      const words = cleanedQuery.trim().split(/\s+/);
      if (words.length > 2) {
        const simplified = words.slice(0, 2).join(' ');
        console.log(`[GIF SEARCH] No results for "${cleanedQuery}". Trying simplified query: "${simplified}"`);
        data = await fetchGifs(simplified);
      }
    }
    
    
    if (data.length === 0 && cleanedQuery.trim().includes(' ')) {
      const firstWord = cleanedQuery.trim().split(/\s+/)[0];
      console.log(`[GIF SEARCH] No results. Trying first word: "${firstWord}"`);
      data = await fetchGifs(firstWord);
    }

    if (data.length > 0) {
      return data.map(item => ({
        id: item.id,
        url: item.images.original.url,
        title: item.title || 'Untitled GIF',
        alt_text: item.alt_text || '',
        still_url: item.images.fixed_width_still?.url || item.images.original_still?.url || ''
      }));
    }
    return [];
  } catch (error) {
    console.error("Giphy search failed:", error.message);
    return [];
  }
}

async function selectBestGif(
  postTitle,
  postContent,
  replyText,
  candidates,
  modelName,
) {
  const visionModel = 'qwen/qwen3.5-397b-a17b';
  const isVisionModel = true;
  
  
  const candidatesText = candidates.map((c, i) => {
    const desc = c.alt_text ? ` (Description: ${c.alt_text})` : '';
    return `${i + 1}. Title: "${c.title}"${desc} (ID: ${c.id})`;
  }).join('\n');

  const prompt = `You are a helpful assistant. You must select the best GIF from the list below to accompany a Reddit reply.

Post Title: "${postTitle}"
Post Content: "${postContent}"
Our Reply: "${replyText}"

GIF Candidates:
${candidatesText}

Which GIF best fits the context, tone, and humor of our reply?
Respond with a valid JSON object matching the schema: { "choice": number | null }. 
The "choice" field must be the integer index of your selection (1 to ${candidates.length}), or null if none of the candidates fit well or if they are not funny/relevant.
Do not return anything else except the valid JSON.`;

  try {
    let userContent;

    if (isVisionModel) {
      console.log(`[GIF SELECT] Model "${visionModel}" is a vision model. Fetching still images for ${candidates.length} candidates...`);
      
      const imagePromises = candidates.map(async (c, i) => {
        if (c.still_url) {
          const img = await fetchImageBase64(c.still_url);
          return { index: i + 1, image: img };
        }
        return { index: i + 1, image: null };
      });
      const fetchedImages = await Promise.all(imagePromises);

      userContent = [
        {
          type: 'text',
          text: prompt
        }
      ];

      fetchedImages.forEach((item) => {
        if (item.image) {
          userContent.push({
            type: 'text',
            text: `--- Still Image for GIF Candidate ${item.index} ---`
          });
          userContent.push({
            type: 'image_url',
            image_url: {
              url: `data:${item.image.contentType};base64,${item.image.base64}`
            }
          });
        }
      });
    } else {
      userContent = prompt;
    }

    const response = await openai.chat.completions.create({
      model: visionModel,
      messages: [{ role: 'user', content: userContent }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    const content = response.choices[0].message.content.trim();
    console.log(`[GIF SELECT] LLM raw response:`, content);
    const result = JSON.parse(content);
    return result.choice;
  } catch (error) {
    console.error('[GIF SELECT] Error choosing GIF:', error.message);
    return null;
  }
}

export { generateResponse, searchGiphy, selectBestGif };
