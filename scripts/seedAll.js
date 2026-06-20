import {
  initDatabase,
  initEmbeddingModel,
  generateEmbedding,
  pool,
  cleanRedditText,
} from '../lib/database.js';
import Reddit from 'reddit';
import dotenv from 'dotenv';

dotenv.config();

const reddit = new Reddit({
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
  appId: process.env.REDDIT_APP_ID,
  appSecret: process.env.REDDIT_APP_SECRET,
  userAgent: 'NITJalandhar/1.0.0 (by Opensource@NITJalandhar)',
});

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
      const response = await reddit.get(`/r/${subreddit}/new`, {
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
      `\nStarting ingestion for ${allPosts.length} posts with concurrency limit 8...`,
    );
    let postStored = 0;
    let commentsStored = 0;

    const CONCURRENCY_LIMIT = 8;

    await runWithLimit(allPosts, CONCURRENCY_LIMIT, async (post, i) => {
      console.log(
        `[${i + 1}/${allPosts.length}] Processing post ${post.id}: "${post.title.substring(0, 50)}..."`,
      );

      const postExists = await pool.query(
        'SELECT id FROM posts WHERE id = $1',
        [post.id],
      );
      if (postExists.rows.length === 0) {
        const rawText = `Post Title: ${post.title}\nPost Content: ${post.selftext || 'No text'}`;
        const text = `passage: ${cleanRedditText(rawText)}`;
        const output = await generateEmbedding(text, {
          pooling: 'mean',
          normalize: true,
        });
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;

        await pool.query(
          'INSERT INTO posts (id, title, selftext, author, created_utc, url, post_hint, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING',
          [
            post.id,
            post.title,
            post.selftext,
            post.author,
            post.created_utc,
            post.url,
            post.post_hint,
            embeddingString,
          ],
        );
        postStored++;
        console.log(`[${post.id}] -> Stored new post`);
      }

      try {
        const commResponse = await reddit.get(`/comments/${post.id}`, {
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
              const text = `passage: Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
              const output = await generateEmbedding(text, {
                pooling: 'mean',
                normalize: true,
              });
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
