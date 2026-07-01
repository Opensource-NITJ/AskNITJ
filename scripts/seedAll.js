import {
  initDatabase,
  initEmbeddingModel,
  generateEmbedding,
  pool,
  cleanRedditText,
} from '../lib/database.js';
import { describeImage, describeVideo } from '../handlers/aiHelpers.js';
import fetch from 'node-fetch';
import Reddit from 'reddit';
import dotenv from 'dotenv';

dotenv.config();

const reddit = new Reddit({
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
  appId: process.env.REDDIT_APP_ID,
  appSecret: process.env.REDDIT_APP_SECRET,
  userAgent: 'NITJalandhar/1.2.0(by Opensource@NITJalandhar)',
});

async function redditGetWithRetry(
  url,
  params,
  retries = 3,
  initialDelay = 3000,
) {
  let delay = initialDelay;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await reddit.get(url, params);
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      console.warn(
        `[API WARNING] Reddit API call to ${url} failed (attempt ${i + 1}/${retries}): ${error.message}. Retrying in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // exponential backoff
    }
  }
}

function extractComments(commentListing, postId) {
  const comments = [];
  if (
    !commentListing ||
    !commentListing.data ||
    !commentListing.data.children
  ) {
    return comments;
  }
  for (const child of commentListing.data.children) {
    if (child.kind === 't1') {
      const data = child.data;
      if (data.body) {
        comments.push({
          id: data.id,
          post_id: postId,
          parent_id:
            data.parent_id && data.parent_id.startsWith('t1_')
              ? data.parent_id.split('_')[1]
              : null,
          author: data.author,
          body: data.body,
          created_utc: data.created_utc,
        });
      }
      if (data.replies) {
        comments.push(...extractComments(data.replies, postId));
      }
    }
  }
  return comments;
}

async function runWithLimit(tasks, limit, workerFn) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        const task = tasks[currentIndex];
        try {
          await workerFn(task, currentIndex);
        } catch (error) {
          console.error(`Error in worker at index ${currentIndex}:`, error);
        }
      }
    },
  );
  await Promise.all(workers);
}

async function seed() {
  try {
    console.log('Initializing embedding model and database...');
    await initEmbeddingModel();
    await initDatabase();

    const subreddit = process.env.REDDIT_SUBREDDIT || 'NITJalandhar';
    console.log(`Fetching posts from r/${subreddit}...`);

    let after = null;
    let allPosts = [];
    let fetchMore = true;

    while (fetchMore) {
      console.log(
        `Fetching next batch of posts (after: ${after || 'beginning'})...`,
      );
      const response = await redditGetWithRetry(`/r/${subreddit}/new`, {
        limit: 100,
        after: after,
        show: 'all',
      });

      const children = response.data.children;
      if (!children || children.length === 0) {
        console.log('No more posts returned.');
        fetchMore = false;
        break;
      }

      const posts = children.map((child) => ({
        id: child.data.id,
        title: child.data.title,
        selftext: child.data.selftext || '',
        author: child.data.author,
        created_utc: child.data.created_utc,
        post_hint: child.data.post_hint || '',
        url: child.data.url || '',
        is_video: child.data.is_video || false,
        video_url:
          child.data.media?.reddit_video?.fallback_url ||
          child.data.secure_media?.reddit_video?.fallback_url ||
          '',
        fullname: child.kind + '_' + child.data.id,
      }));

      allPosts.push(...posts);
      after = posts[posts.length - 1].fullname;

      console.log(
        `Retrieved ${posts.length} posts (Total fetched: ${allPosts.length})`,
      );

      if (children.length < 100) {
        fetchMore = false;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(
      `\nStarting ingestion for ${allPosts.length} posts with concurrency limit 5...`,
    );
    let postStored = 0;
    let commentsStored = 0;

    const CONCURRENCY_LIMIT = 5;

    await runWithLimit(allPosts, CONCURRENCY_LIMIT, async (post, i) => {
      console.log(
        `[${i + 1}/${allPosts.length}] Processing post ${post.id}: "${post.title.substring(0, 50)}..."`,
      );

      const postExists = await pool.query(
        'SELECT id FROM posts WHERE id = $1',
        [post.id],
      );
      if (postExists.rows.length === 0) {
        // Describe media at seed time
        let imageDescription = '';
        const imageUrl = post.post_hint === 'image' ? post.url : null;
        const videoUrl =
          post.is_video || post.post_hint === 'hosted:video'
            ? post.secure_media?.reddit_video?.fallback_url ||
              post.video_url ||
              ''
            : '';

        if (imageUrl) {
          try {
            console.log(`[${post.id}] Describing image...`);
            const image = await fetch(imageUrl);
            const mimeType = image.headers.get('Content-Type') || 'image/png';
            const imageData = Buffer.from(await image.arrayBuffer()).toString(
              'base64',
            );
            imageDescription = await describeImage(imageData, mimeType);
          } catch (err) {
            console.warn(
              `[${post.id}] Failed to describe image: ${err.message}`,
            );
          }
        } else if (videoUrl) {
          try {
            console.log(`[${post.id}] Describing video...`);
            imageDescription = await describeVideo(videoUrl);
          } catch (err) {
            console.warn(
              `[${post.id}] Failed to describe video: ${err.message}`,
            );
          }
        }

        let rawText = `Post Title: ${post.title}\nPost Content: ${post.selftext || 'No text'}`;
        if (imageDescription) {
          rawText += `\nMedia Description: ${imageDescription}`;
        }
        const text = `${cleanRedditText(rawText)}`;
        const output = await generateEmbedding(text);
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;

        await pool.query(
          'INSERT INTO posts (id, title, selftext, author, created_utc, url, post_hint, video_url, image_description, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING',
          [
            post.id,
            post.title,
            post.selftext,
            post.author,
            post.created_utc,
            post.url,
            post.post_hint,
            videoUrl,
            imageDescription || '',
            embeddingString,
          ],
        );
        postStored++;
        console.log(
          `[${post.id}] -> Stored new post${imageDescription ? ' (with media description)' : ''}`,
        );
      }

      try {
        const commResponse = await redditGetWithRetry(`/comments/${post.id}`, {
          limit: 500,
          depth: 10,
        });

        if (Array.isArray(commResponse) && commResponse.length > 1) {
          const rawComments = extractComments(commResponse[1], post.id);
          if (rawComments.length > 0) {
            console.log(
              `[${post.id}] -> Found ${rawComments.length} comments. Ingesting...`,
            );
          }

          for (const comment of rawComments) {
            const commentExists = await pool.query(
              'SELECT id FROM comments WHERE id = $1',
              [comment.id],
            );
            if (commentExists.rows.length === 0) {
              const text = `Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
              const output = await generateEmbedding(text);
              const embedding = Array.from(output.data);
              const embeddingString = `[${embedding.join(',')}]`;

              await pool.query(
                'INSERT INTO comments (id, post_id, parent_id, author, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
                [
                  comment.id,
                  comment.post_id,
                  comment.parent_id,
                  comment.author,
                  comment.body,
                  comment.created_utc,
                  embeddingString,
                ],
              );
              commentsStored++;
            }
          }
        }
      } catch (commError) {
        console.error(
          `[${post.id}] Error fetching/storing comments:`,
          commError.message,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });

    console.log(`\nSeeding completed successfully!`);
    console.log(`Total new posts stored: ${postStored}`);
    console.log(`Total new comments stored: ${commentsStored}`);
  } catch (error) {
    console.error('Seeding process encountered an error:', error);
  } finally {
    await pool.end();
  }
}

seed();
