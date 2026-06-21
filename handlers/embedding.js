import { pool, generateEmbedding, getAllPostComments, cleanRedditText } from '../lib/database.js';
import fs from 'fs';

function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return dotProduct;
}

async function storePosts(posts) {
  try {
    let storedCount = 0;
    let skippedCount = 0;
    for (const post of posts) {
      const exists = await pool.query('SELECT id FROM posts WHERE id = $1', [post.id]);
      if (exists.rows.length === 0) {
        const rawText = `Post Title: ${post.title}\nPost Content: ${post.selftext || 'No text'}`;
        const text = `${cleanRedditText(rawText)}`;
        const output = await generateEmbedding(text);
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;
        await pool.query(
          'INSERT INTO posts (id, title, selftext, author, created_utc, url, post_hint, video_url, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING',
          [post.id, post.title, post.selftext || '', post.author, post.created_utc, post.url || '', post.post_hint || '', post.video_url || '', embeddingString]
        );
        storedCount++;
        console.log(`Stored new post ${post.id} by ${post.author}: ${post.title}`);
      } else {
        skippedCount++;
        console.log(`Skipped post ${post.id}: Already exists in database`);
      }
    }
    console.log(`Stored ${storedCount} new posts, skipped ${skippedCount} existing posts (total processed: ${posts.length})`);
  } catch (error) {
    console.error('Error storing posts:', error.message);
  }
}

async function storeComments(comments) {
  try {
    let storedCount = 0;
    for (const comment of comments) {
      const exists = await pool.query('SELECT id FROM comments WHERE id = $1', [comment.id]);
      if (exists.rows.length === 0) {
        const text = `Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
        const output = await generateEmbedding(text);
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;
        await pool.query(
          'INSERT INTO comments (id, post_id, parent_id, author, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
          [comment.id, comment.post_id, comment.parent_id, comment.author, comment.body, comment.created_utc, embeddingString]
        );
        storedCount++;
        console.log(`Stored new comment ${comment.id} by ${comment.author} on post ${comment.post_id}`);
      }
    }
    console.log(`Stored ${storedCount} new comments in database (total processed: ${comments.length})`);
  } catch (error) {
    console.error('Error storing comments:', error.message);
  }
}

async function storeDMs(messages) {
  try {
    let storedCount = 0;
    for (const message of messages) {
      const exists = await pool.query('SELECT id FROM messages WHERE id = $1', [message.id]);
      if (exists.rows.length === 0) {
        const text = `Message: ${cleanRedditText(message.body)}`;
        const output = await generateEmbedding(text);
        const embedding = Array.from(output.data);
        const embeddingString = `[${embedding.join(',')}]`;
        await pool.query(
          'INSERT INTO messages (id, sender, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
          [message.id, message.sender, message.body, message.created_utc, embeddingString]
        );
        storedCount++;
        console.log(`Stored new DM ${message.id} from ${message.sender}`);
      }
    }
    console.log(`Stored ${storedCount} new DMs in database (total processed: ${messages.length})`);
  } catch (error) {
    console.error('Error storing DMs:', error.message);
  }
}

async function getRelevantContextFromPgvector(item, isDM) {
  try {
    const queryText = isDM ? item.body : `${item.title} ${item.selftext || ''}`;
    const cleanedQuery = cleanRedditText(queryText);
    const tsQuery = cleanRedditText(queryText, true);
    const queryEmbeddingOutput = await generateEmbedding(`${cleanedQuery}`, 'query');
    const queryEmbedding = Array.from(queryEmbeddingOutput.data);
    const embeddingString = `[${queryEmbedding.join(',')}]`;

    const wikiDir = './assets/redditPosts/';
    let wikiContext = '';
    if (fs.existsSync(wikiDir)) {
      const wikiFiles = fs.readdirSync(wikiDir).filter(file => file.endsWith('.txt') || file.endsWith('.md'));
      const wikiSimilarities = [];

      for (const file of wikiFiles) {
        const fileContent = fs.readFileSync(`${wikiDir}${file}`, 'utf-8');
        const wikiEmbeddingOutput = await generateEmbedding(`${fileContent}`);
        const wikiEmbedding = Array.from(wikiEmbeddingOutput.data);
        const similarity = cosineSimilarity(queryEmbedding, wikiEmbedding);
        
        if (similarity > 0.5) {
          wikiSimilarities.push({ file, content: fileContent, similarity });
        }
      }

      wikiSimilarities.sort((a, b) => b.similarity - a.similarity);
      const relevantWikis = wikiSimilarities.slice(0, 3);

      if (relevantWikis.length > 0) {
        wikiContext = 'Reddit Wiki Context:\n';
        for (const wiki of relevantWikis) {
          wikiContext += `\n---\nWiki from ${wiki.file} (similarity: ${wiki.similarity.toFixed(2)}):\n${wiki.content}\n`;
        }
      }
    }

    const vectorPostQuery = `
      SELECT id, title, selftext, author, 1 - (embedding <=> $1) AS similarity
      FROM posts
      WHERE embedding IS NOT NULL
      ORDER BY similarity DESC
      LIMIT 10
    `;
    const vectorPostResult = await pool.query(vectorPostQuery, [embeddingString]);

    let keywordPostResult = { rows: [] };
    if (tsQuery) {
      try {
        const keywordPostQuery = `
          SELECT id, title, selftext, author
          FROM posts
          WHERE to_tsvector('english', title || ' ' || coalesce(selftext, '')) @@ to_tsquery('english', $1)
          LIMIT 10
        `;
        keywordPostResult = await pool.query(keywordPostQuery, [tsQuery.replace(/\s+/g, ' & ')]);
      } catch (error) {
        console.warn(`Keyword search for posts failed: ${error.message}`);
      }
    }

    const combinedPosts = [...vectorPostResult.rows, ...keywordPostResult.rows].reduce((acc, row) => {
      acc[row.id] = acc[row.id] || row;
      acc[row.id].similarity = Math.max(acc[row.id].similarity || 0, row.similarity || 0);
      return acc;
    }, {});
    const sortedPosts = Object.values(combinedPosts).sort((a, b) => (b.similarity || 0) - (a.similarity || 0)).slice(0, 5);

    let context = ''
    for (const post of sortedPosts) {
      context += `Post Title (Only Use it for Context): ${post.title}\nContent (Only Use it for Context): ${post.selftext || 'No text'}\n`;
      const comments = await getAllPostComments(post.id, []);
      context += `Comments:\n${comments.length > 0 ? comments.map(c => `- ${c.body} (by ${c.author})`).join('\n') : 'No comments'}\n\n`;
    }
    context += wikiContext ? `\nUse these reddit posts as a source of information (wikis), do not include these as a part of query:\n\n${wikiContext}` : '';

    const vectorCommentQuery = `
      SELECT id, post_id, body, author, 1 - (embedding <=> $1) AS similarity
      FROM comments
      WHERE embedding IS NOT NULL
      ORDER BY similarity DESC
      LIMIT 10
    `;
    const vectorCommentResult = await pool.query(vectorCommentQuery, [embeddingString]);

    let keywordCommentResult = { rows: [] };
    if (tsQuery) {
      try {
        const keywordCommentQuery = `
          SELECT id, post_id, body, author
          FROM comments
          WHERE to_tsvector('english', body) @@ to_tsquery('english', $1)
          LIMIT 10
        `;
        keywordCommentResult = await pool.query(keywordCommentQuery, [tsQuery.replace(/\s+/g, ' & ')]);
      } catch (error) {
        console.warn(`Keyword search for comments failed: ${error.message}`);
      }
    }

    const combinedComments = [...vectorCommentResult.rows, ...keywordCommentResult.rows].reduce((acc, row) => {
      acc[row.id] = acc[row.id] || row;
      acc[row.id].similarity = Math.max(acc[row.id].similarity || 0, row.similarity || 0);
      return acc;
    }, {});
    const sortedComments = Object.values(combinedComments).sort((a, b) => (b.similarity || 0) - (a.similarity || 0)).slice(0, 5);

    if (sortedComments.length > 0) {
      context += `Relevant Comments (Only use below for information, this will not be included in the query. Always refer to the title and selftext for the user's question. Dont blabber according to these):\n${sortedComments.map(c => `- ${c.body} (by ${c.author})`).join('\n')}\n\n`;
    }

    console.log(`[${isDM ? 'DM' : 'POST'} ${item.id}] tsQuery: ${tsQuery}`);
    console.log(`[${isDM ? 'DM' : 'POST'} ${item.id}] Context size: ${context.length} characters (${sortedPosts.length} posts, ${sortedComments.length} comments)`);
    console.log(`[${isDM ? 'DM' : 'POST'} ${item.id}] Context: ${context.slice(0, 200)}...`);
    return context || 'No context available';
  } catch (error) {
    console.error(`[${isDM ? 'DM' : 'POST'} ${item.id}] Error fetching context:`, error.message);
    return 'No context available';
  }
}

async function validateResponseContent(content) {
  try {
    const output = await generateEmbedding(`${cleanRedditText(content)}`, 'query');
    const queryEmbedding = `[${Array.from(output.data).join(',')}]`;

    const commentsResult = await pool.query(`
      SELECT id, body AS content, 1 - (embedding <=> $1) AS similarity
      FROM comments
      WHERE embedding IS NOT NULL AND 1 - (embedding <=> $1) > $2
      ORDER BY similarity DESC
      LIMIT $3
    `, [queryEmbedding, 0.6, 10]);

    const commentCount = commentsResult.rows.length;
    console.log(`Validation for response: "${content.slice(0, 50)}..."`);
    console.log(`Found ${commentCount} similar comments:`);
    commentsResult.rows.forEach((row, index) => {
      console.log(`Comment ${index + 1} (ID: ${row.id}, Similarity: ${row.similarity.toFixed(3)}): ${row.content.slice(0, 100)}...`);
    });

    if (commentCount < 2) {
      console.log('Insufficient comment support for response, marking as unreliable');
      return { isReliable: false, commentCount, similarComments: commentsResult.rows };
    }

    return { isReliable: true, commentCount, similarComments: commentsResult.rows };
  } catch (error) {
    console.error('Error validating response content:', error.message);
    return { isReliable: false, commentCount: 0, similarComments: [] };
  }
}

export { storePosts, storeComments, storeDMs, getRelevantContextFromPgvector, validateResponseContent };