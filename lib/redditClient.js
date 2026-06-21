import Reddit from 'reddit';
import { pool } from './database.js';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

const reddit = new Reddit({
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
  appId: process.env.REDDIT_APP_ID,
  appSecret: process.env.REDDIT_APP_SECRET,
  userAgent: 'NITJalandhar/1.0.0 (by Opensource@NITJalandhar)',
});

async function submitTextPost(title, text) {
  try {
    const response = await reddit.post('/api/submit', {
      sr: process.env.REDDIT_SUBREDDIT,
      kind: 'self',
      title: title,
      text: text,
      sendreplies: true,
    });
    console.log('Text post submitted:', response.json.data.url);
    return response.json.data;
  } catch (error) {
    console.error('Error submitting text post:', error.message);
    throw error;
  }
}

async function getNewPosts(limit = 5) {
  try {
    const response = await reddit.get(
      `/r/${process.env.REDDIT_SUBREDDIT}/new`,
      {
        limit: limit,
        show: 'all',
      },
    );
    const posts = response.data.children.map((child) => ({
      id: child.data.id,
      title: child.data.title,
      selftext: child.data.selftext || '',
      author: child.data.author,
      created_utc: child.data.created_utc,
      post_hint: child.data.post_hint || '',
      url: child.data.url || '',
      is_video: child.data.is_video || false,
      video_url: child.data.media?.reddit_video?.fallback_url || child.data.secure_media?.reddit_video?.fallback_url || '',
    }));
    console.log(
      `Fetched ${posts.length} new posts from r/${process.env.REDDIT_SUBREDDIT}`,
    );
    return posts;
  } catch (error) {
    console.error('Error fetching new posts:', error.message);
    throw error;
  }
}

async function getNewComments(limit = 5) {
  try {
    const response = await reddit.get(
      `/r/${process.env.REDDIT_SUBREDDIT}/comments`,
      {
        limit: limit,
        show: 'all',
      },
    );
    const comments = response.data.children
      .map((child) => ({
        id: child.data.id,
        post_id: child.data.link_id.split('_')[1],
        parent_id: child.data.parent_id.startsWith('t1_') ? child.data.parent_id.split('_')[1] : null,
        author: child.data.author,
        body: child.data.body,
        created_utc: child.data.created_utc,
      }))
      .filter((comment) => comment.body);
    console.log(
      `Fetched ${comments.length} new comments from r/${process.env.REDDIT_SUBREDDIT}`,
    );
    return comments;
  } catch (error) {
    console.error('Error fetching new comments:', error.message);
    throw error;
  }
}

async function getNewDMs(limit = 5) {
  try {
    const response = await reddit.get('/message/inbox', {
      limit: limit,
      show: 'all',
    });
    const messages = response.data.children
      .filter((child) => child.kind === 't4' && child.data.was_comment === false && child.data.author !== process.env.REDDIT_USERNAME)
      .map((child) => ({
        id: child.data.id,
        sender: child.data.author,
        body: child.data.body,
        created_utc: child.data.created_utc,
      }))
      .filter((message) => message.body);
    console.log(`Found: ${JSON.stringify(messages)}`);

    const newMessages = [];
    for (const message of messages) {
      const exists = await pool.query('SELECT id FROM messages WHERE id = $1', [message.id]);
      if (exists.rows.length === 0) {
        newMessages.push(message);
      }
    }

    console.log(`Fetched ${newMessages.length} new DMs (after filtering)`);
    return newMessages;
  } catch (error) {
    console.error('Error fetching new DMs:', error.message);
    throw error;
  }
}

async function sendDM(recipient, text, body) {
  try {
    await reddit.post('/api/compose', {
      to: recipient,
      subject: `↳ ${body}`,
      text: text,
    });
    console.log(`Sent DM to ${recipient}: ${text}`);
  } catch (error) {
    console.error(`Error sending DM to ${recipient}:`, error.message);
    throw error;
  }
}

async function commentOnPost(postId, text) {
  try {
    console.log(`Trying to comment on post ${postId}: ${text}`);
    const response = await reddit.post('/api/comment', {
      thing_id: `t3_${postId}`,
      text: text,
    });
    console.log(`Commented on post ${postId}: ${text}`);
    return response;
  } catch (error) {
    console.error(`Error commenting on post ${postId}:`, error.message);
    throw error;
  }
}

async function replyDM(messageid, reply) {
  try {
    console.log(`Replying to DM ${messageid}: ${reply}`);
    await reddit.post('/api/comment', {
      thing_id: `t4_${messageid}`,
      text: reply,
    });
  } catch (error) {
    console.error(`Error replying to DM ${messageid}:`, error.message);
    throw error;
  }
}

async function replyToComment(commentId, text) {
  try {
    console.log(`Replying to comment ${commentId}: ${text}`);
    const response = await reddit.post('/api/comment', {
      thing_id: `t1_${commentId}`,
      text: text,
    });
    console.log(`Replied to comment ${commentId}: ${text}`);
    return response;
  } catch (error) {
    console.error(`Error replying to comment ${commentId}:`, error.message);
    throw error;
  }
}

async function getUserOverview(username, limit = 10) {
  try {
    const response = await reddit.get(`/user/${username}/overview`, {
      limit: limit,
      show: 'all',
    });
    console.log(chalk.redBright(`Fetching overview for user ${username}...`));
    console.log(chalk.redBright(`Response: ${JSON.stringify(response.data)}`));
    const overview = response.data.children.map((child) => ({
      kind: child.kind,
      id: child.data.id,
      content: child.kind === 't3' ? child.data.selftext || child.data.title : child.data.body,
      created_utc: child.data.created_utc,
      subreddit: child.kind === 't3' ? child.data.subreddit : child.data.subreddit_name_prefixed,
    }));
    console.log(`Fetched ${overview.length} items for user ${username}`);
    return overview;
  } catch (error) {
    console.error(`Error fetching overview for user ${username}:`, error.message);
    return [];
  }
}

export { submitTextPost, getNewPosts, getNewComments, getNewDMs, sendDM, commentOnPost, replyDM, replyToComment, getUserOverview };