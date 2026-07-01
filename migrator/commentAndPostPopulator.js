import Reddit from 'reddit';
import dotenv from 'dotenv';
import express from 'express';
import { 
  pool, 
  initDatabase, 
  generateEmbedding, 
  cleanRedditText,
  initEmbeddings
} from '../lib/database.js';
import {
  describeImage,
  describeVideo,
  detectMediaType,
  isCrosspostUrl,
  fetchCrosspostContent,
} from '../handlers/aiHelpers.js';
import fetch from 'node-fetch';

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
    const newPosts = response.data.children.map((child) => {
      let selftext = child.data.selftext || '';
      if (child.data.poll_data) {
        const optionsText = child.data.poll_data.options
          ? child.data.poll_data.options.map((opt, index) => `${index + 1}. ${opt.text}`).join('\n')
          : '';
        if (optionsText) {
          selftext = `${selftext}\n\n[Reddit Poll Options]:\n${optionsText}`.trim();
        }
      }
      return {
        id: child.data.id,
        title: child.data.title,
        selftext: selftext,
        author: child.data.author,
        created_utc: child.data.created_utc,
        post_hint: child.data.post_hint || '',
        url: child.data.url || '',
        is_video: child.data.is_video || false,
        video_url: child.data.media?.reddit_video?.fallback_url || child.data.secure_media?.reddit_video?.fallback_url || '',
      };
    });
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

async function describePostMedia(post) {
  let imageUrl = post.post_hint === 'image' ? post.url : null;
  let videoUrl = (post.is_video || post.post_hint === 'hosted:video') ? post.video_url : '';

  // Handle reposts/crossposts: post_hint is 'link' but URL is actually media
  if (!imageUrl && !videoUrl) {
    const mediaType = detectMediaType(post.url);
    if (mediaType === 'image') {
      imageUrl = post.url;
      console.log(`  [${post.id}] 🔄 Repost detected: treating link as image (${post.url.slice(0, 70)})`);
    } else if (mediaType === 'video') {
      // For v.redd.it links without a direct video_url, try constructing the CMAF fallback URL
      if (/^https?:\/\/v\.redd\.it\//i.test(post.url)) {
        const baseVideoUrl = post.url.replace(/\/$/, '');
        videoUrl = `${baseVideoUrl}/CMAF_360.mp4?source=fallback`;
        console.log(`  [${post.id}] 🔄 Repost detected: treating link as v.redd.it video, trying ${videoUrl.slice(0, 70)}`);
      } else {
        videoUrl = post.url;
        console.log(`  [${post.id}] 🔄 Repost detected: treating link as video (${post.url.slice(0, 70)})`);
      }
    }
  }

  if (imageUrl) {
    try {
      console.log(`  [${post.id}] 🖼️  Describing image: ${imageUrl.slice(0, 70)}...`);
      const image = await fetch(imageUrl);
      if (!image.ok) {
        console.warn(`  [${post.id}] ⚠️  Image fetch failed (HTTP ${image.status})`);
        return '';
      }
      const mimeType = image.headers.get('Content-Type') || 'image/png';
      const imageData = Buffer.from(await image.arrayBuffer()).toString('base64');
      const desc = await describeImage(imageData, mimeType);
      if (desc) {
        console.log(`  [${post.id}] ✅ Image described (${desc.length} chars)`);
        return desc;
      }
    } catch (err) {
      console.warn(`  [${post.id}] ⚠️  Failed to describe image: ${err.message}`);
    }
  } else if (videoUrl) {
    try {
      console.log(`  [${post.id}] 🎬 Describing video: ${videoUrl.slice(0, 70)}...`);
      const desc = await describeVideo(videoUrl);
      if (desc) {
        console.log(`  [${post.id}] ✅ Video described (${desc.length} chars)`);
        return desc;
      }
    } catch (err) {
      console.warn(`  [${post.id}] ⚠️  Failed to describe video: ${err.message}`);
    }
  }

  return '';
}

async function storePosts(posts) {
  let storedCount = 0;
  let skippedCount = 0;
  let mediaCount = 0;
  let crosspostCount = 0;
  const total = posts.length;

  for (let i = 0; i < total; i++) {
    const post = posts[i];
    const exists = await pool.query('SELECT id FROM posts WHERE id = $1', [post.id]);

    if (exists.rows.length > 0) {
      skippedCount++;
      continue;
    }

    console.log(`[${i + 1}/${total}] Processing post ${post.id}: "${post.title.slice(0, 60)}..."`);

    // Handle crossposts: if URL is a Reddit permalink and selftext is empty,
    // fetch the original post's content
    let effectiveSelftext = post.selftext || '';
    let effectivePost = { ...post };

    if (!effectiveSelftext && isCrosspostUrl(post.url)) {
      console.log(`  [${post.id}] 📌 Crosspost detected (url: ${post.url.slice(0, 70)}), fetching original...`);
      const original = await fetchCrosspostContent(post.url);
      if (original) {
        // Build attributed selftext: prefix with crosspost context
        const parts = [];
        const originInfo = original.subreddit ? ` from r/${original.subreddit}` : '';
        if (original.title && original.title !== post.title) {
          parts.push(`[Crossposted${originInfo} — Original Title: "${original.title}"]`);
        } else {
          parts.push(`[Crossposted${originInfo}]`);
        }
        if (original.selftext) {
          parts.push(original.selftext);
        }
        effectiveSelftext = parts.join('\n');
        effectivePost.selftext = effectiveSelftext;
        console.log(`  [${post.id}] ✅ Built crosspost selftext (${effectiveSelftext.length} chars)`);

        // Use the original post's media info if our post has none
        if (!effectivePost.post_hint || effectivePost.post_hint === 'link') {
          effectivePost.post_hint = original.post_hint || effectivePost.post_hint;
        }
        if (!effectivePost.video_url && original.video_url) {
          effectivePost.video_url = original.video_url;
        }
        if (original.is_video) {
          effectivePost.is_video = true;
        }
        // Use the original post's direct URL if ours is just a permalink
        if (original.url && original.url !== post.url) {
          effectivePost.url = original.url;
          console.log(`  [${post.id}] 🔗 Using original post URL: ${effectivePost.url.slice(0, 70)}`);
        }
        crosspostCount++;
      }
      // Small delay after Reddit API call
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Describe media at migration time (using enriched crosspost data)
    const imageDescription = await describePostMedia(effectivePost);
    if (imageDescription) mediaCount++;

    // Build embedding text (title + body + media description if available)
    let rawText = `Post Title: ${post.title}\nPost Content: ${effectiveSelftext || 'No text'}`;
    if (imageDescription) {
      rawText += `\nMedia Description: ${imageDescription}`;
    }
    const chunks = chunkText(cleanRedditText(rawText));
    const text = `${chunks[0]}`;
    const output = await generateEmbedding(text);
    const embedding = Array.from(output.data);
    const embeddingString = `[${embedding.join(',')}]`;

    const videoUrl = (effectivePost.is_video || effectivePost.post_hint === 'hosted:video') ? effectivePost.video_url : '';

    await pool.query(
      'INSERT INTO posts (id, title, selftext, author, created_utc, url, post_hint, video_url, image_description, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING',
      [post.id, post.title, effectiveSelftext, post.author, post.created_utc, post.url, post.post_hint, videoUrl, imageDescription, embeddingString]
    );
    storedCount++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`\n📊 Posts Summary: Stored ${storedCount}, Skipped ${skippedCount}, Media described: ${mediaCount}, Crossposts fetched: ${crosspostCount} (total processed: ${total})`);
}

async function storeComments(comments) {
  let storedCount = 0;
  let skippedCount = 0;
  const total = comments.length;

  for (let i = 0; i < total; i++) {
    const comment = comments[i];
    const exists = await pool.query('SELECT id FROM comments WHERE id = $1', [comment.id]);

    if (exists.rows.length > 0) {
      skippedCount++;
      continue;
    }

    const text = `Comment on Post ${comment.post_id}: ${cleanRedditText(comment.body)}`;
    const output = await generateEmbedding(text);
    const embedding = Array.from(output.data);
    const embeddingString = `[${embedding.join(',')}]`;
    await pool.query(
      'INSERT INTO comments (id, post_id, parent_id, author, body, created_utc, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
      [comment.id, comment.post_id, comment.parent_id, comment.author, comment.body, comment.created_utc, embeddingString]
    );
    storedCount++;

    if (storedCount % 50 === 0) {
      console.log(`  Comments progress: ${storedCount} stored so far...`);
    }
  }

  console.log(`\n📊 Comments Summary: Stored ${storedCount}, Skipped ${skippedCount} (total processed: ${total})`);
}

async function fetchAndStoreAllContent() {
  await initDatabase();
  console.log('\n=== PHASE 1: Fetching & Storing Posts (with media descriptions) ===\n');
  const allPosts = await getAllPosts();
  await storePosts(allPosts);

  console.log('\n=== PHASE 2: Fetching & Storing Comments ===\n');
  const allComments = await getAllComments();
  await storeComments(allComments);

  console.log('\n=== PHASE 3: Initializing Wiki Embeddings ===\n');
  await initEmbeddings();
  console.log('\n✅ Migration complete!\n');
}

app.get('/', (req, res) => {
  res.send('NIT Jalandhar Reddit Bot Migrator is running!');
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