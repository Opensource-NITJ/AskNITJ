import { generatePostResponse } from '../handlers/postResponseGenerator.js';
import { commentOnPost, getUserOverview } from '../lib/redditClient.js';
import { addComment } from '../lib/database.js';
import chalk from 'chalk';

async function newPostProcessor(posts) {
  for (const post of posts) {
    try {
      console.log(chalk.magenta('[POST]') + ` Processing post ${post.id}: ${post.title}`);
      let response = await generatePostResponse(post);
      while (response.action === 'query_user') {
        const username = response.text;
        console.log(chalk.magenta('[POST]') + ` Querying user ${username} for post ${post.id}`);
        const userData = await getUserOverview(username);
        const userContext = userData
          .map(
            (item) =>
              `${item.kind === 't3' ? 'Post' : 'Comment'} in r/${item.subreddit}: ${item.content}`,
          )
          .join('\n');
        response = await generatePostResponse(post, {
          username,
          data: userContext,
        });
      }
      if (
        response.action === 'reply' &&
        response.text &&
        response.text.trim()
      ) {
        const redditResponse = await commentOnPost(post.id, response.text);

        console.log(chalk.magenta('[POST]') + ` Commented on post ${post.id}: ${response.text.slice(0, 100)}...`);

        try {
          const commentData = redditResponse.json.data.things[0].data;
          const commentToSave = {
            id: commentData.id,
            post_id: commentData.link_id.split('_')[1],
            parent_id: null,
            author: commentData.author,
            body: commentData.body,
            created_utc: commentData.created_utc,
          };
          await addComment(commentToSave);
        } catch (dbError) {
          console.error(chalk.red('[ERROR]') + ` Error storing bot post reply in DB:`, dbError.message);
        }
      } else {
        console.log(chalk.magenta('[POST]') + ` Skipping post ${post.id}: action is ${response.action}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(chalk.red('[ERROR]') + ` Error processing post ${post.id}:`, error.message);
    }
  }
}

export { newPostProcessor };
