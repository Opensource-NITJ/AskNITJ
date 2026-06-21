import { generateResponse } from '../handlers/responseGenerator.js';
import { replyToComment, getUserOverview } from '../lib/redditClient.js';
import { getRelevantContextFromPgvector } from '../handlers/embedding.js';
import { getCommentThread, getPostDetails, getAllPostComments, isParentByBot, addComment } from '../lib/database.js';
import dotenv from 'dotenv';
dotenv.config();

async function newCommentProcessor(comments) {
  console.log(comments)
  for (const comment of comments) {
    try {
      console.log(`Processing comment ${comment.id} on post ${comment.post_id}: ${comment.body.slice(0, 100)}...`);

      if (comment.author === process.env.REDDIT_USERNAME) {
        console.log(`Skipping comment ${comment.id}: Posted by the bot itself`);
        continue;
      }

      const mentionsBot = comment.body.toLowerCase().includes(`u/${process.env.REDDIT_USERNAME.toLowerCase()}`);
      const isReplyToBot = await isParentByBot(comment);

      if (!mentionsBot && !isReplyToBot) {
        console.log(`Skipping comment ${comment.id}: Does not mention or reply to u/${process.env.REDDIT_USERNAME}`);
        continue;
      }

      const post = await getPostDetails(comment.post_id);
      if (!post) {
        console.log(`Skipping comment ${comment.id}: Post ${comment.post_id} not found`);
        continue;
      }

      const thread = await getCommentThread(comment.id, comment.post_id);
      const threadIds = thread.map(c => c.id);
      const threadContext = thread.map(c => `Comment by ${c.author} (ID: ${c.id}) (Replying to ${c.parent_id}): ${c.body}`).join('\n\n');

      const otherComments = await getAllPostComments(comment.post_id, threadIds);
      const otherCommentsContext = otherComments.map(c => `Comment by ${c.author} (ID: ${c.id}) (Replying to ${c.parent_id}): ${c.body}`).join('\n\n');

      const pgvectorContext = await getRelevantContextFromPgvector({
        id: comment.id,
        body: comment.body,
        post_id: comment.post_id,
        title: post.title,
        selftext: post.selftext,
      }, false);

      const context = [
        `Post Title: ${post.title}`,
        `Post Content: ${post.selftext || 'No text'}`,
        `Post Author: ${post.author}`,
        `Image URL: ${post.post_hint === 'image' ? post.url : 'No image provided'}`,
        `Video URL: ${post.post_hint === 'hosted:video' ? post.video_url : 'No video provided'}`,
        `Comment Thread:\n${threadContext || 'No thread context'}`,
        `Other Comments on Post:\n${otherCommentsContext || 'No other comments'}`,
        `Relevant Context from Database:\n${pgvectorContext || 'No relevant context'}`,
        ``,
        `You really don't have to reply to this comment. You can just ignore it by using '0canthelpwiththisquery0' as your response. You must only reply if the user is asking for help. You don't need to start unnecessary conversations.`,
      ].join('\n\n');

      let response = await generateResponse(
        { title: `Comment on Post ${post.title}`, selftext: comment.body, ...(() => {
          const { body, ...rest } = comment;
          return rest;
        })() },
        false,
        true,
        context
      );

      while (response.action === 'query_user') {
        const username = response.text;
        console.log(`Querying user ${username} for comment ${comment.id}`);
        const userData = await getUserOverview(username);
        const userContext = userData
          .map((item) => `${item.kind === 't3' ? 'Post' : 'Comment'} in r/${item.subreddit}: ${item.content}`)
          .join('\n');
        response = await generateResponse(
          { ...comment, title: `Comment on Post ${post.title}` },
          false,
          true,
          `${context}\n\nUser ${username} context:\n${userContext}`
        );
      }

      if (response.action === 'reply' && !response.text.includes('0canthelpwiththisquery0')) {
        const redditResponse = await replyToComment(comment.id, response.text);
        console.log(`Replied to comment ${comment.id}: ${response.text}`);

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
          console.error(`Error storing bot comment reply in DB:`, dbError.message);
        }
      } else {
        console.log(`Skipping comment ${comment.id}: Invalid response or '0canthelpwiththisquery0'`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error processing comment ${comment.id}:`, error.message);
    }
  }
}

export { newCommentProcessor };