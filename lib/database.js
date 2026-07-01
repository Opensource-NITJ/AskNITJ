import { Pool } from 'pg';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import chalk from 'chalk';

dotenv.config();

const pool = new Pool({
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DATABASE || 'local',
  password: process.env.PG_PASSWORD || 'your_password',
  port: process.env.PG_PORT || 5432,
  max: parseInt(process.env.PG_POOL_MAX) || 15,
});

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || 'nvidia/llama-nemotron-embed-1b-v2';

function cleanRedditText(text, forTsQuery = false) {
  let cleaned = text
    .replace(/[*\[\]#>`]+/g, '')
    .replace(/[^\w\s.,!??]/g, '')
    .trim();
  if (forTsQuery) {
    cleaned = cleaned
      .replace(/[.,!??]/g, '')
      .replace(/\b\d+\b/g, '')
      .replace(/\b[^\w\s]+\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    cleaned = cleaned
      .split(' ')
      .filter((word) => word.length > 2 && /^[a-zA-Z]+$/.test(word))
      .join(' ');
    if (!cleaned) cleaned = '';
  }
  return cleaned;
}

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

async function initEmbeddingModel() {
  return null;
}

function normalizeL2(vector) {
  let sumOfSquares = 0;
  for (const val of vector) {
    sumOfSquares += val * val;
  }
  const magnitude = Math.sqrt(sumOfSquares);
  if (magnitude === 0) return vector;
  return vector.map((val) => val / magnitude);
}

async function generateEmbedding(text, inputType = 'passage') {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error(
      'NVIDIA_API_KEY is not defined in the environment variables',
    );
  }

  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(
        'https://integrate.api.nvidia.com/v1/embeddings',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: text,
            input_type: inputType,
            encoding_format: 'float',
          }),
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const result = await response.json();
      let embedding = result.data[0].embedding;

      if (embedding.length > 1024) {
        embedding = normalizeL2(embedding.slice(0, 1024));
      }

      return { data: embedding };
    } catch (error) {
      console.error(chalk.red('[ERROR]') + ` [EMBEDDING] Failed on attempt ${4 - retries}/3:`, error.message);
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        throw error;
      }
    }
  }
}

async function initDatabase() {
  try {
    await pool.query(
      'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public',
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id VARCHAR(50) PRIMARY KEY,
        title TEXT NOT NULL,
        selftext TEXT,
        author VARCHAR(50) NOT NULL,
        created_utc BIGINT NOT NULL,
        url TEXT,
        post_hint VARCHAR(50),
        image_description TEXT,
        embedding vector(1024)
      );
    `);
    await pool.query(`
      ALTER TABLE posts
      ADD COLUMN IF NOT EXISTS url TEXT,
      ADD COLUMN IF NOT EXISTS post_hint VARCHAR(50),
      ADD COLUMN IF NOT EXISTS video_url TEXT,
      ADD COLUMN IF NOT EXISTS image_description TEXT;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id VARCHAR(50) PRIMARY KEY,
        post_id VARCHAR(50) NOT NULL,
        parent_id VARCHAR(50),
        author VARCHAR(50) NOT NULL,
        body TEXT NOT NULL,
        created_utc BIGINT NOT NULL,
        embedding vector(1024)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dms (
        id VARCHAR(50) PRIMARY KEY,
        sender VARCHAR(50) NOT NULL,
        recipient VARCHAR(50) NOT NULL,
        body TEXT NOT NULL,
        created_utc BIGINT NOT NULL,
        embedding vector(1024)
      );
    `);

    await pool.query(
      'CREATE INDEX IF NOT EXISTS posts_embedding_idx ON posts USING hnsw (embedding vector_cosine_ops)',
    );
    await pool.query(
      'CREATE INDEX IF NOT EXISTS comments_embedding_idx ON comments USING hnsw (embedding vector_cosine_ops)',
    );
    await pool.query(
      'CREATE INDEX IF NOT EXISTS dms_embedding_idx ON dms USING hnsw (embedding vector_cosine_ops)',
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS posts_fts_idx ON posts USING GIN (to_tsvector('english', title || ' ' || coalesce(selftext, '')));",
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS comments_fts_idx ON comments USING GIN (to_tsvector('english', body));",
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS dms_fts_idx ON dms USING GIN (to_tsvector('english', body));",
    );
    console.log(
      chalk.blue('[DATABASE]') + ' Database initialized with pgvector, dms table and full-text search indices'
    );
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ' Error initializing database:', error.message);
    throw error;
  }
}

async function initEmbeddings() {
  try {
    const postsResult = await pool.query(
      'SELECT id, title, selftext, author FROM posts WHERE embedding IS NULL',
    );
    const commentsResult = await pool.query(
      'SELECT id, post_id, body, author FROM comments WHERE embedding IS NULL',
    );
    const dmsResult = await pool.query(
      'SELECT id, body FROM dms WHERE embedding IS NULL',
    );
    const posts = postsResult.rows;
    const comments = commentsResult.rows;
    const dmsRows = dmsResult.rows;

    for (const post of posts) {
      const rawText = `Post Title: ${post.title}\nPost Content: ${post.selftext || 'No text'}`;
      const chunks = chunkText(cleanRedditText(rawText));
      const text = `${chunks[0]}`;
      const output = await generateEmbedding(text);
      const embedding = Array.from(output.data);
      const embeddingString = `[${embedding.join(',')}]`;
      await pool.query('UPDATE posts SET embedding = $1 WHERE id = $2', [
        embeddingString,
        post.id,
      ]);
    }
    for (const comment of comments) {
      const text = `Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
      const output = await generateEmbedding(text);
      const embedding = Array.from(output.data);
      const embeddingString = `[${embedding.join(',')}]`;
      await pool.query('UPDATE comments SET embedding = $1 WHERE id = $2', [
        embeddingString,
        comment.id,
      ]);
    }
    for (const dmRow of dmsRows) {
      const text = `Message: ${cleanRedditText(dmRow.body)}`;
      const output = await generateEmbedding(text);
      const embedding = Array.from(output.data);
      const embeddingString = `[${embedding.join(',')}]`;
      await pool.query('UPDATE dms SET embedding = $1 WHERE id = $2', [
        embeddingString,
        dmRow.id,
      ]);
    }
    console.log(
      chalk.blue('[DATABASE]') + ` Initialized embeddings for ${posts.length} posts, ${comments.length} comments, and ${dmsRows.length} dms`
    );
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ' Error initializing embeddings:', error.message);
  }
}

async function addDM(dm) {
  try {
    const { id, sender, recipient, body, created_utc } = dm;
    const cleanedBody = cleanRedditText(body);
    const output = await generateEmbedding(`Message: ${cleanedBody}`);
    const embedding = Array.from(output.data);
    const embeddingString = `[${embedding.join(',')}]`;
    await pool.query(
      'INSERT INTO dms (id, sender, recipient, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
      [id, sender, recipient, body, created_utc, embeddingString]
    );
    console.log(chalk.blue('[DATABASE]') + ` Stored DM ${id} in database`);
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` Error saving DM to database:`, error.message);
  }
}

async function getDMHistory(username, limit = 20) {
  try {
    const botUsername = process.env.REDDIT_USERNAME || 'AskNITJ';
    const result = await pool.query(
      `SELECT sender, recipient, body, created_utc 
       FROM dms 
       WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)
       ORDER BY created_utc DESC 
       LIMIT $3`,
      [username, botUsername, limit]
    );
    return result.rows.reverse();
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` Error fetching DM history:`, error.message);
    return [];
  }
}

async function getPostImageDescription(postId) {
  if (!postId) return null;
  try {
    const result = await pool.query('SELECT image_description FROM posts WHERE id = $1', [postId]);
    if (result.rows.length > 0 && result.rows[0].image_description) {
      return result.rows[0].image_description;
    }
    return null;
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ' Error fetching post image description:', error.message);
    return null;
  }
}

async function updatePostImageDescription(postId, description) {
  if (!postId || !description) return;
  try {
    await pool.query(
      'UPDATE posts SET image_description = $1 WHERE id = $2',
      [description, postId]
    );
    console.log(chalk.yellow('[MEDIA]') + ` Saved image_description for post ${postId}`);
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ' Error saving post image description:', error.message);
  }
}

async function addComment(comment) {
  try {
    const { id, post_id, parent_id, author, body, created_utc } = comment;
    const cleanedBody = cleanRedditText(body);
    const output = await generateEmbedding(
      `Comment on Post ${post_id}: ${cleanedBody}`,
    );
    const embeddingString = `[${Array.from(output.data).join(',')}]`;
    await pool.query(
      'INSERT INTO comments (id, post_id, parent_id, author, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
      [id, post_id, parent_id, author, body, created_utc, embeddingString],
    );
    console.log(chalk.blue('[DATABASE]') + ` Added comment ${id} to post ${post_id}`);
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` Error adding comment ${comment.id}:`, error.message);
  }
}

async function getCommentThread(commentId, postId) {
  try {
    let currentId = commentId;
    const threadComments = [];
    const seenIds = new Set();

    while (currentId && !seenIds.has(currentId)) {
      const commentResult = await pool.query(
        'SELECT id, post_id, parent_id, author, body, created_utc FROM comments WHERE id = $1',
        [currentId],
      );
      if (commentResult.rows.length === 0) break;
      const comment = commentResult.rows[0];
      threadComments.push(comment);
      seenIds.add(currentId);
      currentId = comment.parent_id;
    }

    const allChildren = [];
    async function fetchChildren(parentId) {
      const childrenResult = await pool.query(
        'SELECT id, post_id, parent_id, author, body, created_utc FROM comments WHERE parent_id = $1',
        [parentId],
      );
      for (const child of childrenResult.rows) {
        if (!seenIds.has(child.id)) {
          allChildren.push(child);
          seenIds.add(child.id);
          await fetchChildren(child.id);
        }
      }
    }

    for (const comment of threadComments) {
      await fetchChildren(comment.id);
    }

    const thread = [...threadComments, ...allChildren].sort(
      (a, b) => a.created_utc - b.created_utc,
    );
    return thread.map((comment) => ({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      parent_id: comment.parent_id,
      created_utc: comment.created_utc,
    }));
  } catch (error) {
    console.error(
      chalk.red('[ERROR]') + ` Error fetching comment thread for comment ${commentId}:`,
      error.message,
    );
    return [];
  }
}

async function getPostDetails(postId) {
  try {
    const postResult = await pool.query(
      'SELECT id, title, selftext, author, post_hint, url, video_url, image_description FROM posts WHERE id = $1',
      [postId],
    );
    if (postResult.rows.length === 0) return null;
    return postResult.rows[0];
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` Error fetching post ${postId}:`, error.message);
    return null;
  }
}

async function getAllPostComments(postId, excludeCommentIds) {
  try {
    const commentsResult = await pool.query(
      'SELECT * FROM comments WHERE post_id = $1 AND id != ALL($2) ORDER BY created_utc ASC',
      [postId, excludeCommentIds],
    );
    return commentsResult.rows.map((comment) => ({
      id: comment.id,
      post_id: comment.post_id,
      parent_id: comment.parent_id,
      author: comment.author,
      body: comment.body,
      created_utc: comment.created_utc,
    }));
  } catch (error) {
    console.error(chalk.red('[ERROR]') + ` Error fetching comments for post ${postId}:`, error.message);
    return [];
  }
}

async function isParentByBot(comment) {
  if (!comment.parent_id) return false;
  const parentResult = await pool.query(
    'SELECT author FROM comments WHERE id = $1',
    [comment.parent_id],
  );
  return (
    parentResult.rows.length > 0 &&
    parentResult.rows[0].author === process.env.REDDIT_USERNAME
  );
}

export {
  pool,
  initDatabase,
  initEmbeddings,
  initEmbeddingModel,
  generateEmbedding,
  getCommentThread,
  getPostDetails,
  getAllPostComments,
  isParentByBot,
  addComment,
  cleanRedditText,
  addDM,
  getDMHistory,
  getPostImageDescription,
  updatePostImageDescription,
};
