import { generateCommentResponse } from '../handlers/commentResponseGenerator.js';
import { replyToComment, getUserOverview } from '../lib/redditClient.js';
import { getPostDetails, isParentByBot, addComment } from '../lib/database.js';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

async function newCommentProcessor(comments) {
  for (const comment of comments) {
    try {
      console.log(
        chalk.cyan('[COMMENT]') + ` Processing comment ${comment.id} on post ${comment.post_id}: ${comment.body.slice(0, 100)}...`,
      );

      if (comment.author === process.env.REDDIT_USERNAME) {
        console.log(chalk.cyan('[COMMENT]') + ` Skipping comment ${comment.id}: Posted by the bot itself`);
        continue;
      }

      const mentionsBot = comment.body
        .toLowerCase()
        .includes(`u/${process.env.REDDIT_USERNAME.toLowerCase()}`);
      const isReplyToBot = await isParentByBot(comment);

      if (!mentionsBot && !isReplyToBot) {
        console.log(
          chalk.cyan('[COMMENT]') + ` Skipping comment ${comment.id}: Does not mention or reply to u/${process.env.REDDIT_USERNAME}`,
        );
        continue;
      }

      const post = await getPostDetails(comment.post_id);
      if (!post) {
        console.log(
          chalk.cyan('[COMMENT]') + ` Skipping comment ${comment.id}: Post ${comment.post_id} not found`,
        );
        continue;
      }

      const additionalContext = `You really don't have to reply to this comment. You can just ignore it by setting action to 'dont_reply'. You must only reply if the user is asking for help or asking a valid question. You don't need to start unnecessary conversations.`;

      let response = await generateCommentResponse(
        comment,
        post,
        null,
        additionalContext,
      );

      while (response.action === 'query_user') {
        const username = response.text;
        console.log(chalk.cyan('[COMMENT]') + ` Querying user ${username} for comment ${comment.id}`);
        const userData = await getUserOverview(username);
        const userContext = userData
          .map(
            (item) =>
              `${item.kind === 't3' ? 'Post' : 'Comment'} in r/${item.subreddit}: ${item.content}`,
          )
          .join('\n');

        response = await generateCommentResponse(
          comment,
          post,
          { username, data: userContext },
          additionalContext,
        );
      }

      if (
        response.action === 'reply' &&
        response.text &&
        response.text.trim()
      ) {
        const redditResponse = await replyToComment(comment.id, response.text);
        console.log(chalk.cyan('[COMMENT]') + ` Replied to comment ${comment.id}: ${response.text.slice(0, 100)}...`);

        try {
          const commentData = redditResponse.json.data.things[0].data;
          const commentToSave = {
            id: commentData.id,
            post_id: commentData.link_id.split('_')[1],
            parent_id: commentData.parent_id.split('_')[1],
            author: commentData.author,
            body: commentData.body,
            created_utc: commentData.created_utc,
          };
          await addComment(commentToSave);
        } catch (dbError) {
          console.error(
            chalk.red('[ERROR]') + ` Error storing bot comment reply in DB:`,
            dbError.message,
          );
        }
      } else {
        console.log(
          chalk.cyan('[COMMENT]') + ` Skipping comment ${comment.id}: action is ${response.action}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(chalk.red('[ERROR]') + ` Error processing comment ${comment.id}:`, error.message);
    }
  }
}

export { newCommentProcessor };
