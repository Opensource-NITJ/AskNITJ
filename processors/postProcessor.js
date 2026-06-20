import { generateResponse } from '../handlers/responseGenerator.js';
import { commentOnPost, getUserOverview } from '../lib/redditClient.js';

async function newPostProcessor(posts) {
  for (const post of posts) {
    try {
      console.log(`Processing post ${post.id}: ${post.title}`);
      let response = await generateResponse(post, false, false);
      while (response.action === 'query_user') {
        const username = response.text;
        console.log(`Querying user ${username} for post ${post.id}`);
        const userData = await getUserOverview(username);
        const userContext = userData
          .map(
            (item) =>
              `${item.kind === 't3' ? 'Post' : 'Comment'} in r/${item.subreddit}: ${item.content}`,
          )
          .join('\n');
        response = await generateResponse(
          post,
          false,
          false,
          `User ${username} context:\n${userContext}`,
        );
      }
      if (
        response.action === 'reply' &&
        response.text !== '0canthelpwiththisquery0'
      ) {
        await commentOnPost(post.id, response.text);

        console.log(`Commented on post ${post.id}: ${response.text}`);
      } else {
        console.log(
          `Skipping post ${post.id} as it contains '0canthelpwiththisquery0' or invalid action`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error processing post ${post.id}:`, error.message);
    }
  }
}

export { newPostProcessor };
