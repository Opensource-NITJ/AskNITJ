import { generatePostResponse } from '../handlers/postResponseGenerator.js';
import { getUserOverview } from '../lib/redditClient.js';
import { getPostDetails, initDatabase, pool } from '../lib/database.js';
import { storePosts } from '../handlers/embedding.js';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

async function run() {
  const args = process.argv.slice(2);
  const postId = args[0] || '1ujr2le';

  console.log(
    chalk.yellowBright('[MIMIC PROCESSOR]') +
      ` Mimicking postProcessor.js for Post ID: ${postId}`,
  );
  await initDatabase();

  const post = await getPostDetails(postId);
  if (!post) {
    console.error(
      chalk.red('[ERROR]') +
        ` [MIMIC PROCESSOR] Post with ID ${postId} not found in database.`,
    );
    process.exit(1);
  }

  console.log(
    chalk.yellowBright('[MIMIC PROCESSOR]') +
      ` Processing post ${post.id}: ${post.title}`,
  );

  console.log(
    chalk.yellowBright('[MIMIC PROCESSOR]') +
      ` Running ingestion pipeline (crossposts, media descriptions, embeddings)...`,
  );
  await storePosts([post]);

  let response = await generatePostResponse(post);

  while (response.action === 'query_user') {
    const username = response.text;
    console.log(
      chalk.yellowBright('[MIMIC PROCESSOR]') +
        ` Querying user ${username} for post ${post.id}`,
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
    response = await generatePostResponse(post, {
      username,
      data: userContext,
    });
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
