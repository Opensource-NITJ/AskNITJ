import Reddit from 'reddit';
import dotenv from 'dotenv';
import { generateResponse } from '../handlers/responseGenerator.js';
import { pool } from '../lib/database.js';

dotenv.config();

const reddit = new Reddit({
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
  appId: process.env.REDDIT_APP_ID,
  appSecret: process.env.REDDIT_APP_SECRET,
  userAgent: 'NITJalandhar/1.0.0 (by Opensource@NITJalandhar)',
});

async function run() {
  const input = process.argv[2];
  if (!input) {
    console.error("Error: Please provide a Reddit post URL or Post ID.");
    console.error("Usage: node scripts/testPostResponse.js <reddit_post_url_or_post_id>");
    process.exit(1);
  }

  // Extract Reddit post ID (e.g. 1ubirgy) if a full URL is passed, otherwise use it directly
  let postId = input;
  if (input.includes('/comments/')) {
    const match = input.match(/\/comments\/([a-z0-9]+)/i);
    if (match) {
      postId = match[1];
    } else {
      console.error("Error: Invalid Reddit post URL format.");
      process.exit(1);
    }
  }

  console.log(`Fetching post ${postId} from Reddit...`);
  try {
    const response = await reddit.get(`/comments/${postId}`);
    const postData = response[0]?.data?.children[0]?.data;

    if (!postData) {
      throw new Error("Could not retrieve post data from Reddit API response.");
    }

    const postItem = {
      id: postData.id,
      title: postData.title,
      selftext: postData.selftext || '',
      author: postData.author,
      created_utc: postData.created_utc,
      post_hint: postData.post_hint || '',
      url: postData.url || '',
      is_video: postData.is_video || false,
      video_url: postData.media?.reddit_video?.fallback_url || postData.secure_media?.reddit_video?.fallback_url || '',
    };

    console.log(`Generating response for post ${postItem.id}: "${postItem.title}"`);
    console.log(`Post Type: ${postItem.is_video ? 'VIDEO' : postItem.post_hint === 'image' ? 'IMAGE' : 'TEXT'}`);

    const result = await generateResponse(postItem, false, false);
    
    console.log("\n=== Bot Generated Response ===");
    console.log(JSON.stringify(result, null, 2));
    console.log("==============================\n");

  } catch (error) {
    console.error("Execution failed:", error.message);
  } finally {
    await pool.end();
  }
}

run();
