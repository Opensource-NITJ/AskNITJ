import Reddit from 'reddit';
import dotenv from 'dotenv';
import express from 'express';
import { 
  pool, 
  initDatabase, 
  generateEmbedding, 
  cleanRedditText 
} from '../lib/database.js';

dotenv.config();

const reddit = new Reddit({
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
  appId: process.env.REDDIT_APP_ID,
  appSecret: process.env.REDDIT_APP_SECRET,
  userAgent: 'NITJalandhar/1.0.0 (by Opensource@NITJalandhar)',
});

const port = process.env.PORT || 8080;
const app = express();
app.use(express.json());

function chunkText(text, maxTokens = 512) {
  const words = text.split(' ');
  const chunks = [];
  let currentChunk = '';
  for (const word of words) {
    if ((currentChunk + ' ' + word).length < maxTokens) {
      currentChunk += (currentChunk ? ' ' : '') + word;
    } else {
      chunks.push(currentChunk);
      currentChunk = word;
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

async function initEmbeddings() {
  const postsResult = await pool.query('SELECT id, title, selftext, author FROM posts WHERE embedding IS NULL');
  const commentsResult = await pool.query('SELECT id, post_id, body, author FROM comments WHERE embedding IS NULL');
  const posts = postsResult.rows;
  const comments = commentsResult.rows;

  for (const post of posts) {
    const rawText = `Post Title: ${post.title}\nPost Content: ${post.selftext || 'No text'}`;
    const chunks = chunkText(cleanRedditText(rawText));
    const text = `${chunks[0]}`;
    const output = await generateEmbedding(text);
    const embedding = Array.from(output.data);
    const embeddingString = `[${embedding.join(',')}]`;
    await pool.query('UPDATE posts SET embedding = $1 WHERE id = $2', [embeddingString, post.id]);
  }
  for (const comment of comments) {
    const text = `Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
    const output = await generateEmbedding(text);
    const embedding = Array.from(output.data);
    const embeddingString = `[${embedding.join(',')}]`;
    await pool.query('UPDATE comments SET embedding = $1 WHERE id = $2', [embeddingString, comment.id]);
  }
  console.log(`Initialized embeddings for ${posts.length} posts, ${comments.length} comments`);
}

async function getAllPosts() {
  let posts = [];
  let after = null;
  const maxPerRequest = 100;

  while (true) {
    const response = await reddit.get(
      `/r/${process.env.REDDIT_SUBREDDIT}/new`,
      {
        limit: maxPerRequest,
        show: 'all',
        after: after,
      }
    );
    const newPosts = response.data.children.map((child) => ({
      id: child.data.id,
      title: child.data.title,
      selftext: child.data.selftext || '',
      author: child.data.author,
      created_utc: child.data.created_utc,
      post_hint: child.data.post_hint || '',
      url: child.data.url || '',
    }));
    posts = posts.concat(newPosts);
    after = response.data.after;
    console.log(
      `Fetched ${newPosts.length} new posts (total: ${posts.length}) from r/${process.env.REDDIT_SUBREDDIT}`
    );
    if (!after || newPosts.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return posts;
}

async function getAllComments() {
  let comments = [];
  let after = null;
  const maxPerRequest = 100;

  while (true) {
    const response = await reddit.get(
      `/r/${process.env.REDDIT_SUBREDDIT}/comments`,
      {
        limit: maxPerRequest,
        show: 'all',
        after: after,
      }
    );
    const newComments = response.data.children
      .map((child) => ({
        id: child.data.id,
        post_id: child.data.link_id.split('_')[1],
        parent_id: child.data.parent_id.startsWith('t1_') ? child.data.parent_id.split('_')[1] : null,
        author: child.data.author,
        body: child.data.body,
        created_utc: child.data.created_utc,
      }))
      .filter((comment) => comment.body);
    comments = comments.concat(newComments);
    after = response.data.after;
    console.log(
      `Fetched ${newComments.length} new comments (total: ${comments.length}) from r/${process.env.REDDIT_SUBREDDIT}`
    );
    if (!after || newComments.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return comments;
}

async function storePosts(posts) {
  let storedCount = 0;
  for (const post of posts) {
    const exists = await pool.query('SELECT id FROM posts WHERE id = $1', [post.id]);
    if (exists.rows.length === 0) {
      const rawText = `Post Title: ${post.title}\nPost Content: ${post.selftext || 'No text'}`;
      const chunks = chunkText(cleanRedditText(rawText));
      const text = `${chunks[0]}`;
      const output = await generateEmbedding(text);
      const embedding = Array.from(output.data);
      const embeddingString = `[${embedding.join(',')}]`;
      await pool.query(
        'INSERT INTO posts (id, title, selftext, author, created_utc, url, post_hint, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [post.id, post.title, post.selftext, post.author, post.created_utc, post.url, post.post_hint, embeddingString]
      );
      storedCount++;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.log(`Stored ${storedCount} new posts in database (total processed: ${posts.length})`);
}

async function storeComments(comments) {
  let storedCount = 0;
  for (const comment of comments) {
    const exists = await pool.query('SELECT id FROM comments WHERE id = $1', [comment.id]);
    if (exists.rows.length === 0) {
      const text = `Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
      const output = await generateEmbedding(text);
      const embedding = Array.from(output.data);
      const embeddingString = `[${embedding.join(',')}]`;
      await pool.query(
        'INSERT INTO comments (id, post_id, parent_id, author, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [comment.id, comment.post_id, comment.parent_id, comment.author, comment.body, comment.created_utc, embeddingString]
      );
      storedCount++;
    }
  }
  console.log(`Stored ${storedCount} new comments in database (total processed: ${comments.length})`);
}

async function fetchAndStoreAllContent() {
  await initDatabase();
  const allPosts = await getAllPosts();
  await storePosts(allPosts);
  console.log(`Completed fetching and storing ${allPosts.length} posts`);
  const allComments = await getAllComments();
  await storeComments(allComments);
  console.log(`Completed fetching and storing ${allComments.length} comments`);
  await initEmbeddings();
}

app.get('/', (req, res) => {
  res.send('NIT Jalandhar Reddit Bot is running!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    freeMemory: process.memoryUsage().heapUsed,
    memoryLimit: process.memoryUsage().heapTotal,
    timestamp: new Date(),
  });
});

app.listen(port, async () => {
  console.log(`Server is running on http://localhost:${port}`);
  await fetchAndStoreAllContent();
});