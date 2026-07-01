import { generateCommentResponse } from '../handlers/commentResponseGenerator.js';
import { getUserOverview } from '../lib/redditClient.js';
import { getPostDetails, initDatabase, pool } from '../lib/database.js';
import { storePosts, storeComments } from '../handlers/embedding.js';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

async function getCommentDetails(commentId) {
  try {
    const result = await pool.query('SELECT * FROM comments WHERE id = $1', [
      commentId,
    ]);
    return result.rows[0] || null;
  } catch (error) {
    console.error(
      chalk.red('[ERROR]') + ' Error fetching comment from DB:',
      error.message,
    );
    return null;
  }
}

async function run() {
  const args = process.argv.slice(2);
  const commentId = args[0] || 'ous3tqh';

  console.log(
    chalk.yellowBright('[MIMIC PROCESSOR]') +
      ` Mimicking commentProcessor.js for Comment ID: ${commentId}`,
  );
  await initDatabase();

  const comment = await getCommentDetails(commentId);
  if (!comment) {
    console.error(
      chalk.red('[ERROR]') +
        ` [MIMIC PROCESSOR] Comment with ID ${commentId} not found in database.`,
    );
    process.exit(1);
  }

  const post = await getPostDetails(comment.post_id);
  if (!post) {
    console.error(
      chalk.red('[ERROR]') +
        ` [MIMIC PROCESSOR] Parent post ${comment.post_id} not found in database.`,
    );
    process.exit(1);
  }

  console.log(
    chalk.yellowBright('[MIMIC PROCESSOR]') +
      ` Running ingestion pipeline (crossposts, media descriptions, embeddings)...`,
  );
  await storePosts([post]);
  await storeComments([comment]);

  const additionalContext = `You really don't have to reply to this comment. You can just ignore it by setting action to 'dont_reply'. You must only reply if the user is asking for help or asking a valid question. You don't need to start unnecessary conversations.`;

  let response = await generateCommentResponse(
    comment,
    post,
    null,
    additionalContext,
  );

  while (response.action === 'query_user') {
    const username = response.text;
    console.log(
      chalk.yellowBright('[MIMIC PROCESSOR]') +
        ` Querying user ${username} for comment ${comment.id}`,
    );
    const userData = await getUserOverview(username);
    const userContext = userData
      .map(
        (item) =>
          `${item.kind === 't3' ? 'Post' : 'Comment'} in r/${item.subreddit}: ${item.content}`,
      )
      .join('\n');

    console.log(
      chalk.yellowBright('[MIMIC PROCESSOR]') +
        ` User overview context loaded (${userData.length} items). Recalling generator...`,
    );
    response = await generateCommentResponse(
      comment,
      post,
      { username, data: userContext },
      additionalContext,
    );
  }

  console.log('\n========================================');
  console.log('MIMIC PROCESSOR OUTPUT (NOT POSTED):');
  console.log('========================================');
  console.log('Final Action:', response.action);
  if (response.action === 'reply' && response.text) {
    console.log('Text (includes bot signature):\n' + response.text);
  } else {
    console.log('No reply text generated.');
  }
  console.log('========================================');

  try {
    await pool.end();
  } catch (endErr) {
    console.error(
      chalk.red('[ERROR]') + ' Error ending DB pool:',
      endErr.message,
    );
  }
  setTimeout(() => process.exit(0), 200);
}

run().catch(async (err) => {
  console.error(
    chalk.red('[ERROR]') + ` [MIMIC PROCESSOR] Error:`,
    err.message,
  );
  try {
    await pool.end();
  } catch (endErr) {
    // ignore
  }
  setTimeout(() => process.exit(1), 200);
});
