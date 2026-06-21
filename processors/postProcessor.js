import { generateResponse } from '../handlers/responseGenerator.js';
import { commentOnPost, getUserOverview } from '../lib/redditClient.js';
import { addComment } from '../lib/database.js';

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
        const redditResponse = await commentOnPost(post.id, response.text);

        console.log(`Commented on post ${post.id}: ${response.text}`);

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
          console.error(`Error storing bot post reply in DB:`, dbError.message);
        }
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
