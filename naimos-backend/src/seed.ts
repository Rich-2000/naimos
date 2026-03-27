/**
 * ============================================================
 *  NAIMOS AMS — Database Seed Script
 *  Creates the initial NAIMOS admin user in MongoDB Atlas.
 *
 *  Usage:
 *    npx ts-node naimos-backend/src/seed.ts
 *    (or: npm run seed)
 *
 *  This script is idempotent — safe to run multiple times.
 * ============================================================
 */

import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import type { NaimosUser } from './auth';

// Load env in non-production
if (process.env.NODE_ENV !== 'production') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv');
  dotenv.config({ path: '../.env' });
}

const MONGODB_URI = process.env.MONGODB_URI ||
  '';

const BCRYPT_ROUNDS = 14;

const SEED_USERS: Array<Omit<NaimosUser, '_id' | 'passwordHash'> & { plainPassword: string }> = [
  {
    username:      'NAIMOS',
    plainPassword: 'NAIMOS@',
    role:          'admin',
    createdAt:     new Date(),
    updatedAt:     new Date(),
    loginAttempts: 0,
    lockedUntil:   null,
    passwordResetToken:  null,
    passwordResetExpiry: null,
    isActive:      true,
  },
];

async function seed() {
  console.log('\n🌱  NAIMOS Database Seed Starting...\n');

  const client = new MongoClient(MONGODB_URI, {
    connectTimeoutMS: 15_000,
    serverSelectionTimeoutMS: 15_000,
    tls: true,
  });

  try {
    await client.connect();
    console.log('✓  Connected to MongoDB Atlas');

    const db    = client.db(); // uses "naimos" from connection string
    const users = db.collection<NaimosUser>('users');

    // Create a unique index on username to prevent duplicates
    await users.createIndex({ username: 1 }, { unique: true });
    console.log('✓  Unique index on username ensured');

    for (const seedUser of SEED_USERS) {
      const { plainPassword, ...rest } = seedUser;

      const exists = await users.findOne({ username: seedUser.username });
      if (exists) {
        console.log(`⚠  User "${seedUser.username}" already exists — skipping.`);
        continue;
      }

      const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
      const userDoc: NaimosUser = { ...rest, passwordHash };

      await users.insertOne(userDoc);
      console.log(`✓  Created user: ${seedUser.username} (role: ${seedUser.role})`);
    }

    console.log('\n✅  Seed complete.\n');
  } catch (err: any) {
    console.error('\n❌  Seed failed:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seed();