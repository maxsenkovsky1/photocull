import { auth } from '@clerk/nextjs/server';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

/**
 * Get the current Clerk user ID. Creates a row in the users table
 * on first encounter so foreign keys always resolve.
 */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!existing) {
    await db.insert(schema.users).values({ id: userId }).onConflictDoNothing();
  }

  return userId;
}
