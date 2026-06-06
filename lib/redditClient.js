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
    await reddit.post('/api/comment', {
      thing_id: `t3_${postId}`,
      text: text,
    });
    console.log(`Commented on post ${postId}: ${text}`);
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
    await reddit.post('/api/comment', {
      thing_id: `t1_${commentId}`,
      text: text,
    });
    console.log(`Replied to comment ${commentId}: ${text}`);
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

/**
 * Normalize a Reddit username for safe comparison.
 * Strips leading "u/" or "/u/" prefixes and lowercases.
 */
function normalizeUsername(name) {
  if (!name) return '';
  return name.replace(/^\/?(u\/)/i, '').toLowerCase();
}

/**
 * Check if a message item is a genuine DM (not a comment reply).
 * Filters by kind === 't4' and was_comment === false.
 */
function isPrivateMessage(child) {
  return child.kind === 't4' && child.data.was_comment === false;
}

async function getInboxMessagesFromUser(username, limit = 40) {
  try {
    const collectedMessages = [];
    let after = null;
    const maxPages = 3;
    const normalizedTarget = normalizeUsername(username);
    const normalizedBot = normalizeUsername(process.env.REDDIT_USERNAME);

    for (let page = 0; page < maxPages && collectedMessages.length < limit; page++) {
      const params = {
        limit: 100,
        show: 'all',
      };
      if (after) params.after = after;

      const response = await reddit.get('/message/messages', params);
      if (!response.data || !response.data.children || response.data.children.length === 0) break;

      let matchesOnThisPage = 0;

      for (const child of response.data.children) {
        // Fix #3: Only process genuine private messages (t4), skip comment replies
        if (!isPrivateMessage(child)) continue;

        const msg = child.data;
        // Fix #1: Case-insensitive comparison with u/ prefix stripping
        const normalizedAuthor = normalizeUsername(msg.author);
        const normalizedDest = normalizeUsername(msg.dest);
        const isSentByUser = normalizedAuthor === normalizedTarget;
        const isSentByBot = normalizedAuthor === normalizedBot && normalizedDest === normalizedTarget;

        if ((isSentByUser || isSentByBot) && msg.body) {
          collectedMessages.push({
            id: msg.id,
            sender: msg.author,
            recipient: msg.dest,
            body: msg.body,
            subject: msg.subject || '',
            created_utc: msg.created_utc,
            direction: isSentByBot ? 'bot' : 'user',
          });
          matchesOnThisPage++;
        }

        // Also check replies in the message thread
        if (msg.replies && msg.replies.data && msg.replies.data.children) {
          for (const reply of msg.replies.data.children) {
            // Fix #3: Filter nested replies too
            if (reply.kind !== 't4') continue;

            const replyData = reply.data;
            const normalizedReplyAuthor = normalizeUsername(replyData.author);
            const normalizedReplyDest = normalizeUsername(replyData.dest);
            const isReplyByUser = normalizedReplyAuthor === normalizedTarget;
            const isReplyByBot = normalizedReplyAuthor === normalizedBot && normalizedReplyDest === normalizedTarget;

            if ((isReplyByUser || isReplyByBot) && replyData.body) {
              collectedMessages.push({
                id: replyData.id,
                sender: replyData.author,
                recipient: replyData.dest,
                body: replyData.body,
                subject: replyData.subject || '',
                created_utc: replyData.created_utc,
                direction: isReplyByBot ? 'bot' : 'user',
              });
              matchesOnThisPage++;
            }
          }
        }

        if (collectedMessages.length >= limit) break;
      }

      // Fix #2: Early exit — if an entire page had zero matches for this user,
      // there's no point fetching further back in time
      if (matchesOnThisPage === 0) {
        console.log(`No messages from ${username} on page ${page + 1}, stopping pagination early`);
        break;
      }

      after = response.data.after;
      if (!after) break;
    }

    // Deduplicate by message ID
    const uniqueMessages = [...new Map(collectedMessages.map(m => [m.id, m])).values()];

    // Sort chronologically (oldest first) and take the last `limit`
    uniqueMessages.sort((a, b) => a.created_utc - b.created_utc);
    const result = uniqueMessages.slice(-limit);

    console.log(`Fetched ${result.length} inbox messages from/to user ${username} (out of ${uniqueMessages.length} total)`);
    return result;
  } catch (error) {
    console.error(`Error fetching inbox messages for user ${username}:`, error.message);
    return [];
  }
}

export { submitTextPost, getNewPosts, getNewComments, getNewDMs, sendDM, commentOnPost, replyDM, replyToComment, getUserOverview, getInboxMessagesFromUser };