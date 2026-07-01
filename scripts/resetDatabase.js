import { pool } from '../lib/database.js';

async function reset() {
  console.log("Dropping existing tables to migrate vector dimensions back to 1024...");
  try {
    await pool.query('DROP TABLE IF EXISTS comments CASCADE;');
    await pool.query('DROP TABLE IF EXISTS posts CASCADE;');
    await pool.query('DROP TABLE IF EXISTS messages CASCADE;');
    await pool.query('DROP TABLE IF EXISTS dms CASCADE;');
    console.log("Success! Existing tables dropped successfully.");
  } catch (error) {
    console.error("Failed to drop tables:", error.message);
  } finally {
    await pool.end();
  }
}

reset();
