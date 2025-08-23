import { initDatabase, initEmbeddings, pool, initEmbeddingModel } from './lib/database.js';
import { getNewPosts, getNewComments, getNewDMs } from './lib/redditClient.js';
import { newPostProcessor } from './processors/postProcessor.js';
import { newDMProcessor } from './processors/dmProcessor.js';
import { newCommentProcessor } from './processors/commentProcessor.js';
import { startServer } from './lib/server.js';
import { storeComments, storePosts, storeDMs } from './handlers/embedding.js';
import dotenv from 'dotenv';

dotenv.config();

async function startBot() {
  try {
    await initEmbeddingModel();
    await initDatabase();
    await initEmbeddings();
    
    await Promise.all([monitorDM(), monitorSubreddit()]);
  } catch (error) {
    console.error('Error starting bot:', error.message);
  }
}

async function monitorSubreddit() {
  let seenPostIds = new Set();
  let seenCommentIds = new Set();
  let isInitialRun = true;

  try {
    const existingPosts = await pool.query('SELECT id FROM posts');
    existingPosts.rows.forEach((row) => seenPostIds.add(row.id));
    console.log(`Initialized seenPostIds with ${seenPostIds.size} existing post IDs from database`);
    const existingComments = await pool.query('SELECT id FROM comments');
    existingComments.rows.forEach((row) => seenCommentIds.add(row.id));
    console.log(`Initialized seenCommentIds with ${seenCommentIds.size} existing comment IDs from database`);
  } catch (error) {
    console.error('Error loading existing post IDs:', error.message);
  }

  while (true) {
    try {
      const postLimit = isInitialRun ? 100 : 5;
      const commentLimit = isInitialRun ? 100 : 20;

      const newPosts = await getNewPosts(postLimit);
      const newComments = await getNewComments(commentLimit);

      const newPostsToProcess = newPosts.filter((post) => {
        const isNew = !seenPostIds.has(post.id);
        if (!isNew) {
          console.log(`Filtered out post ${post.id}: Already processed`);
        }
        return isNew;
      });
      const newCommentsToProcess = newComments.filter(
        (comment) => !seenCommentIds.has(comment.id),
      );

      if (newPostsToProcess.length > 0 || newCommentsToProcess.length > 0) {
        console.log(
          `New posts to process: ${newPostsToProcess.length}, New comments to process: ${newCommentsToProcess.length}`,
        );
        await storeComments(newCommentsToProcess);
        await storePosts(newPostsToProcess);
        await newPostProcessor(newPostsToProcess);
        await newCommentProcessor(newCommentsToProcess);        
        newPosts.forEach((post) => seenPostIds.add(post.id));
        newComments.forEach((comment) => seenCommentIds.add(comment.id));

        if (seenPostIds.size > 1000) {
          seenPostIds = new Set([...seenPostIds].slice(-1000));
          console.log(`Trimmed seenPostIds to ${seenPostIds.size} entries`);
        }
        if (seenCommentIds.size > 10000) {
          seenCommentIds = new Set([...seenCommentIds].slice(-10000));
          console.log(`Trimmed seenCommentIds to ${seenCommentIds.size} entries`);
        }
      } else {
        console.log('No new posts or comments found.');
      }

      if (isInitialRun) {
        console.log('Initial run complete, switching to normal fetch limits (5 posts, 20 comments).');
        isInitialRun = false;
      }

      await new Promise((resolve) => setTimeout(resolve, 60000));
    } catch (error) {
      console.error('Error in monitorSubreddit:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  }
}

async function monitorDM() {
  let seenMessageIds = new Set();

  while (true) {
    try {
      const newDMs = await getNewDMs(5);
      const newDMsToProcess = newDMs.filter(
        (message) => !seenMessageIds.has(message.id),
      );

      if (newDMsToProcess.length > 0) {
        console.log(`New DMs found: ${newDMsToProcess.length}`);
        
        await storeDMs(newDMsToProcess);
        console.log(`Stored ${newDMsToProcess.length} new DMs in database`);

        const groupedDMs = newDMsToProcess.reduce((acc, message) => {
          const sender = message.sender;
          if (!acc[sender]) {
            acc[sender] = {
              id: message.id,
              sender: sender,
              body: message.body,
              created_utc: message.created_utc,
            };
          } else {
            acc[sender].body = `${message.body}\n${acc[sender].body}`;
            if (message.created_utc > acc[sender].created_utc) {
              acc[sender].id = message.id;
              acc[sender].created_utc = message.created_utc;
            }
          }
          return acc;
        }, {});

        const groupedDMsArray = Object.values(groupedDMs);
        console.log(`Grouped into ${groupedDMsArray.length} message(s) by sender`);

        await newDMProcessor(groupedDMsArray);

        newDMs.forEach((message) => seenMessageIds.add(message.id));
        if (seenMessageIds.size > 1000) {
          seenMessageIds = new Set([...seenMessageIds].slice(-1000));
        }
      } else {
        console.log('No new DMs found.');
      }

      await new Promise((resolve) => setTimeout(resolve, 60000));
    } catch (error) {
      console.error('Error in monitorDM:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  }
}

startBot();
startServer();