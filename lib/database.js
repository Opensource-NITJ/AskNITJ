import { Pool } from 'pg';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fetch from 'node-fetch';

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

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nvidia/llama-nemotron-embed-1b-v2';

function cleanRedditText(text, forTsQuery = false) {
  let cleaned = text
    // .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/[*\[\]#>`]+/g, '')
    .replace(/[^\w\s.,!?]/g, '')
    .trim();
  if (forTsQuery) {
    cleaned = cleaned
      .replace(/[.,!?]/g, '')
      .replace(/\b\d+\b/g, '')
      .replace(/\b[^\w\s]+\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    cleaned = cleaned.split(' ').filter(word => word.length > 2 && /^[a-zA-Z]+$/.test(word)).join(' ');
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
  return vector.map(val => val / magnitude);
}

async function generateEmbedding(text, inputType = 'passage') {
  try {
    if (!process.env.NVIDIA_API_KEY) {
      throw new Error("NVIDIA_API_KEY is not defined in the environment variables");
    }
    
    const response = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        input_type: inputType,
        encoding_format: 'float'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const result = await response.json();
    let embedding = result.data[0].embedding;
    
    // Slice to 1024 dimensions (Matryoshka Representation Learning) and L2 normalize
    if (embedding.length > 1024) {
      embedding = normalizeL2(embedding.slice(0, 1024));
    }
    
    return { data: embedding };
  } catch (error) {
    console.error('Error generating NVIDIA embedding:', error.message);
    throw error;
  }
}

async function initDatabase() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id VARCHAR(50) PRIMARY KEY,
        title TEXT NOT NULL,
        selftext TEXT,
        author VARCHAR(50) NOT NULL,
        created_utc BIGINT NOT NULL,
        url TEXT,
        post_hint VARCHAR(50),
        embedding vector(1024)
      );
    `);
    await pool.query(`
      ALTER TABLE posts
      ADD COLUMN IF NOT EXISTS url TEXT,
      ADD COLUMN IF NOT EXISTS post_hint VARCHAR(50);
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
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(50) PRIMARY KEY,
        sender VARCHAR(50) NOT NULL,
        body TEXT NOT NULL,
        created_utc BIGINT NOT NULL,
        embedding vector(1024)
      );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS posts_embedding_idx ON posts USING hnsw (embedding vector_cosine_ops)');
    await pool.query('CREATE INDEX IF NOT EXISTS comments_embedding_idx ON comments USING hnsw (embedding vector_cosine_ops)');
    await pool.query('CREATE INDEX IF NOT EXISTS messages_embedding_idx ON messages USING hnsw (embedding vector_cosine_ops)');
    await pool.query("CREATE INDEX IF NOT EXISTS posts_fts_idx ON posts USING GIN (to_tsvector('english', title || ' ' || coalesce(selftext, '')));");
    await pool.query("CREATE INDEX IF NOT EXISTS comments_fts_idx ON comments USING GIN (to_tsvector('english', body));");
    console.log('Database initialized with pgvector and full-text search indices');
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
}

async function initEmbeddings() {
  try {
    const postsResult = await pool.query('SELECT id, title, selftext, author FROM posts WHERE embedding IS NULL');
    const commentsResult = await pool.query('SELECT id, post_id, body, author FROM comments WHERE embedding IS NULL');
    const messagesResult = await pool.query('SELECT id, body FROM messages WHERE embedding IS NULL');
    const posts = postsResult.rows;
    const comments = commentsResult.rows;
    const messages = messagesResult.rows;

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
    for (const message of messages) {
      const text = `Message: ${cleanRedditText(message.body)}`;
      const output = await generateEmbedding(text);
      const embedding = Array.from(output.data);
      const embeddingString = `[${embedding.join(',')}]`;
      await pool.query('UPDATE messages SET embedding = $1 WHERE id = $2', [embeddingString, message.id]);
    }
    console.log(`Initialized embeddings for ${posts.length} posts, ${comments.length} comments, and ${messages.length} messages`);
  } catch (error) {
    console.error('Error initializing embeddings:', error.message);
  }
}

async function addComment(comment) {
  try {
    const { id, post_id, parent_id, author, body, created_utc } = comment;
    const cleanedBody = cleanRedditText(body);
    const output = await generateEmbedding(`Comment on Post ${post_id}: ${cleanedBody}`);
    const embeddingString = `[${Array.from(output.data).join(',')}]`;
    await pool.query(
      'INSERT INTO comments (id, post_id, parent_id, author, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
      [id, post_id, parent_id, author, body, created_utc, embeddingString]
    );
    console.log(`Added comment ${id} to post ${post_id}`);
  } catch (error) {
    console.error(`Error adding comment ${comment.id}:`, error.message);
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
        [currentId]
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
        [parentId]
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

    const thread = [...threadComments, ...allChildren].sort((a, b) => a.created_utc - b.created_utc);
    return thread.map(comment => ({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      parent_id: comment.parent_id,
      created_utc: comment.created_utc,
    }));
  } catch (error) {
    console.error(`Error fetching comment thread for comment ${commentId}:`, error.message);
    return [];
  }
}

async function getPostDetails(postId) {
  try {
    const postResult = await pool.query(
      'SELECT id, title, selftext, author, post_hint, url FROM posts WHERE id = $1',
      [postId]
    );
    if (postResult.rows.length === 0) return null;
    return postResult.rows[0];
  } catch (error) {
    console.error(`Error fetching post ${postId}:`, error.message);
    return null;
  }
}

async function getAllPostComments(postId, excludeCommentIds) {
  try {
    const commentsResult = await pool.query(
      'SELECT id, author, body, created_utc FROM comments WHERE post_id = $1 AND id != ALL($2) ORDER BY created_utc ASC',
      [postId, excludeCommentIds]
    );
    return commentsResult.rows.map(comment => ({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      created_utc: comment.created_utc,
    }));
  } catch (error) {
    console.error(`Error fetching comments for post ${postId}:`, error.message);
    return [];
  }
}

async function isParentByBot(comment) {
  if (!comment.parent_id) return false;
  const parentResult = await pool.query(
    'SELECT author FROM comments WHERE id = $1',
    [comment.parent_id]
  );
  return parentResult.rows.length > 0 && parentResult.rows[0].author === process.env.REDDIT_USERNAME;
}

export { pool, initDatabase, initEmbeddings, initEmbeddingModel, generateEmbedding, getCommentThread, getPostDetails, getAllPostComments, isParentByBot, addComment, cleanRedditText };