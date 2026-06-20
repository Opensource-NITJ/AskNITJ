import { generateResponse } from '../handlers/responseGenerator.js';
import { pool } from '../lib/database.js';
import dotenv from 'dotenv';

dotenv.config();

const testPostTitle = 'night canteen 😍💕';
const testPostContent = '';
const testPostUrl =
  'https://preview.redd.it/night-canteen-v0-7cn6jupxo58h1.jpeg?auto=webp&s=383810561c833245f989516f133a71c756de7f82';
const testPostHint = 'image';

const mockPost = {
  id: 'test_post_local',
  title: testPostTitle,
  selftext: testPostContent,
  url: testPostUrl,
  post_hint: testPostHint,
};

async function test() {
  console.log('-----------------------------------------');
  console.log('Starting Local Response Generation Test');
  console.log(`Mock Post Title: "${mockPost.title}"`);
  console.log(`Mock Post Content: "${mockPost.selftext}"`);
  console.log('-----------------------------------------\n');

  try {
    const result = await generateResponse(mockPost, false, false);

    console.log('\n-----------------------------------------');
    console.log('TEST RESULT:');
    console.log(`Action: ${result.action}`);
    console.log(`Text to comment/reply:`);
    console.log(result.text);
    console.log('-----------------------------------------');
  } catch (error) {
    console.error('Test execution failed:', error);
  } finally {
    await pool.end();
  }
}

test();
