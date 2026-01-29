import { config } from "dotenv";
import { createInterface } from "readline";
import { writeFileSync } from "fs";
import { WorkOS } from "@workos-inc/node";

config();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Rate limiter that allows bursting up to the limit, then waits
class RateLimiter {
  private timestamps: number[] = [];
  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      // Wait until the oldest request expires
      const waitTime = this.timestamps[0] + this.windowMs - now + 10;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.acquire();
    }

    this.timestamps.push(now);
  }
}

// Rate limiters based on WorkOS limits (with safety margins)
const rateLimiters = {
  // Delete Organization: 50 per 60 seconds - use 45 for safety
  deleteOrg: new RateLimiter(45, 60000),
  // AuthKit Writes: 500 per 10 seconds - use 450 for safety
  userWrite: new RateLimiter(450, 10000),
  // AuthKit Reads: 1000 per 10 seconds - use 900 for safety
  userRead: new RateLimiter(900, 10000),
  // General org operations: 6000 per 60 seconds - use 5000 for safety
  orgOp: new RateLimiter(5000, 60000),
};

// Helper to run promises in parallel chunks
async function parallelChunked<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  chunkSize: number,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function confirm(message: string): Promise<boolean> {
  const answer = await question(`${message} (y/n): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function setup(): Promise<{ apiKey: string; email: string }> {
  console.log("\n=== WorkOS CLI Setup ===\n");

  const apiKey = await question("Enter your WorkOS API key: ");
  if (!apiKey.trim()) {
    console.error("API key is required");
    process.exit(1);
  }

  console.log("\nEnter your email (e.g. test@workos.com)");
  console.log(
    "Users will be created as test+1@workos.com, test+2@workos.com, etc.\n",
  );
  const email = await question("Email: ");
  if (!email.includes("@")) {
    console.error("Invalid email format");
    process.exit(1);
  }

  const envContent = `WORKOS_API_KEY=${apiKey.trim()}\nEMAIL=${email.trim()}\n`;
  writeFileSync(".env", envContent);
  console.log("\nConfig saved to .env\n");

  return { apiKey: apiKey.trim(), email: email.trim() };
}

async function main() {
  let apiKey = process.env.WORKOS_API_KEY;
  let email = process.env.EMAIL;

  if (!apiKey || !email) {
    const cfg = await setup();
    apiKey = cfg.apiKey;
    email = cfg.email;
  }

  const workos = new WorkOS(apiKey);

  function generateEmail(n: number): string {
    const [local, domain] = email!.split("@");
    return `${local}+${n}@${domain}`;
  }

  // Fetch all users with pagination
  async function fetchAllUsers(): Promise<
    Array<{ id: string; email: string }>
  > {
    const users: Array<{ id: string; email: string }> = [];
    let after: string | undefined;
    while (true) {
      await rateLimiters.userRead.acquire();
      const { data, listMetadata } = await workos.userManagement.listUsers({
        after,
        limit: 100,
      });
      users.push(...data.map((u) => ({ id: u.id, email: u.email })));
      if (!listMetadata?.after) break;
      after = listMetadata.after;
    }
    return users;
  }

  // Fetch all orgs with pagination
  async function fetchAllOrgs(): Promise<Array<{ id: string; name: string }>> {
    const orgs: Array<{ id: string; name: string }> = [];
    let after: string | undefined;
    while (true) {
      await rateLimiters.orgOp.acquire();
      const { data, listMetadata } =
        await workos.organizations.listOrganizations({ after, limit: 100 });
      orgs.push(...data.map((o) => ({ id: o.id, name: o.name })));
      if (!listMetadata?.after) break;
      after = listMetadata.after;
    }
    return orgs;
  }

  // Fetch all memberships with pagination
  async function fetchAllMemberships(
    orgId?: string,
  ): Promise<Array<{ id: string; userId: string }>> {
    const memberships: Array<{ id: string; userId: string }> = [];
    let after: string | undefined;
    while (true) {
      await rateLimiters.userRead.acquire();
      const { data, listMetadata } =
        await workos.userManagement.listOrganizationMemberships({
          organizationId: orgId,
          after,
          limit: 100,
        });
      memberships.push(...data.map((m) => ({ id: m.id, userId: m.userId })));
      if (!listMetadata?.after) break;
      after = listMetadata.after;
    }
    return memberships;
  }

  const commands: Record<string, (args: string[]) => Promise<void>> = {
    async createOrgs(args) {
      const count = parseInt(args[0], 10);
      if (isNaN(count) || count < 1) {
        console.log("Usage: createOrgs <num>");
        return;
      }

      const indices = Array.from({ length: count }, (_, i) => i + 1);
      await parallelChunked(
        indices,
        async (i) => {
          await rateLimiters.orgOp.acquire();
          try {
            const org = await workos.organizations.createOrganization({
              name: `Organization ${i}`,
            });
            console.log(`Created org "${org.name}" (${org.id})`);
          } catch (error: any) {
            console.error(`Failed to create org "${i}":`, error.message);
          }
        },
        50,
      );
    },

    async createUsers(args) {
      const count = parseInt(args[0], 10);
      const orgId = args[1];
      if (isNaN(count) || count < 1) {
        console.log("Usage: createUsers <num> [orgId]");
        return;
      }

      const indices = Array.from({ length: count }, (_, i) => i + 1);
      await parallelChunked(
        indices,
        async (i) => {
          const userEmail = generateEmail(i);
          try {
            await rateLimiters.userWrite.acquire();
            const user = await workos.userManagement.createUser({
              email: userEmail,
              firstName: userEmail.split("@")[0],
              lastName: String(i),
            });
            if (orgId) {
              await rateLimiters.userWrite.acquire();
              await workos.userManagement.createOrganizationMembership({
                userId: user.id,
                organizationId: orgId,
              });
            }
            console.log(`Created ${userEmail} (${user.id})`);
          } catch (error: any) {
            console.error(`Failed to create ${userEmail}:`, error.message);
          }
        },
        50,
      );
    },

    async createOrgMembership(args) {
      const userId = args[0];
      if (!userId) {
        console.log("Usage: createOrgMembership <userId>");
        return;
      }

      const orgs = await fetchAllOrgs();
      if (orgs.length === 0) {
        console.log("No organizations found");
        return;
      }

      let created = 0;
      await parallelChunked(
        orgs,
        async (org) => {
          try {
            await rateLimiters.userWrite.acquire();
            await workos.userManagement.createOrganizationMembership({
              userId,
              organizationId: org.id,
            });
            created++;
            console.log(`Added user to "${org.name}" (${org.id})`);
          } catch (error: any) {
            console.error(
              `Failed to add user to "${org.name}":`,
              error.message,
            );
          }
        },
        50,
      );

      console.log(`Done - added user to ${created} organizations`);
    },

    async listOrgs() {
      const orgs = await fetchAllOrgs();
      if (orgs.length === 0) {
        console.log("No organizations found");
        return;
      }
      for (const org of orgs) {
        console.log(`${org.name} (${org.id})`);
      }
    },

    async listUsers(args) {
      const orgId = args[0];

      if (orgId) {
        const memberships = await fetchAllMemberships(orgId);
        if (memberships.length === 0) {
          console.log("No users found");
          return;
        }
        // Fetch user details in parallel
        const users = await parallelChunked(
          memberships,
          async (m) => {
            await rateLimiters.userRead.acquire();
            return workos.userManagement.getUser(m.userId);
          },
          100,
        );
        for (const user of users) {
          console.log(`${user.email} (${user.id})`);
        }
      } else {
        const users = await fetchAllUsers();
        if (users.length === 0) {
          console.log("No users found");
          return;
        }
        for (const user of users) {
          console.log(`${user.email} (${user.id})`);
        }
      }
    },

    async deleteAllUsers() {
      const users = await fetchAllUsers();
      if (users.length === 0) {
        console.log("No users found");
        return;
      }

      console.log(`\nFound ${users.length} users to delete.`);
      if (!(await confirm("Are you sure you want to delete all users?"))) {
        console.log("Cancelled");
        return;
      }

      let deleted = 0;
      let failed = 0;
      await parallelChunked(
        users,
        async (user) => {
          try {
            await rateLimiters.userWrite.acquire();
            await workos.userManagement.deleteUser(user.id);
            deleted++;
            console.log(`Deleted ${user.email}`);
          } catch (error: any) {
            failed++;
            console.error(`Failed to delete ${user.email}:`, error.message);
          }
        },
        50,
      );

      console.log(`Done - deleted ${deleted} users${failed > 0 ? `, ${failed} failed` : ""}`);
    },

    async deleteAllOrgs() {
      const orgs = await fetchAllOrgs();
      if (orgs.length === 0) {
        console.log("No organizations found");
        return;
      }

      console.log(`\nFound ${orgs.length} organizations to delete.`);
      const estimatedMinutes = Math.ceil((orgs.length / 45) * 1);
      console.log(
        `Note: This will take ~${estimatedMinutes} minute${estimatedMinutes > 1 ? "s" : ""} due to rate limits (50/min).`,
      );
      if (
        !(await confirm("Are you sure you want to delete all organizations?"))
      ) {
        console.log("Cancelled");
        return;
      }

      let deleted = 0;
      let skipped = 0;
      let failed = 0;
      // Delete orgs sequentially due to strict rate limit (50/60s)
      // but still use the rate limiter for proper timing
      await parallelChunked(
        orgs,
        async (org) => {
          try {
            await rateLimiters.deleteOrg.acquire();
            await workos.organizations.deleteOrganization(org.id);
            deleted++;
            console.log(`Deleted org "${org.name}" (${org.id})`);
          } catch (error: any) {
            const msg = error.message?.toLowerCase() || "";
            // Skip orgs that can't be deleted (e.g., default "Test Organization")
            if (
              msg.includes("cannot be deleted") ||
              msg.includes("can't be deleted") ||
              msg.includes("cannot delete") ||
              msg.includes("unable to delete")
            ) {
              skipped++;
              console.log(`Skipped org "${org.name}" (${org.id}) - cannot be deleted`);
            } else {
              failed++;
              console.error(`Failed to delete org "${org.name}" (${org.id}):`, error.message);
            }
          }
        },
        45, // Process up to 45 at a time (within rate limit window)
      );

      let summary = `Done - deleted ${deleted} organizations`;
      if (skipped > 0) summary += `, ${skipped} skipped`;
      if (failed > 0) summary += `, ${failed} failed`;
      console.log(summary);
    },

    async deleteAllMemberships() {
      const memberships = await fetchAllMemberships();
      if (memberships.length === 0) {
        console.log("No memberships found");
        return;
      }

      console.log(`\nFound ${memberships.length} memberships to delete.`);
      if (
        !(await confirm("Are you sure you want to delete all memberships?"))
      ) {
        console.log("Cancelled");
        return;
      }

      let deleted = 0;
      let failed = 0;
      await parallelChunked(
        memberships,
        async (m) => {
          try {
            await rateLimiters.userWrite.acquire();
            await workos.userManagement.deleteOrganizationMembership(m.id);
            deleted++;
            console.log(`Deleted membership ${m.id}`);
          } catch (error: any) {
            failed++;
            console.error(`Failed to delete membership ${m.id}:`, error.message);
          }
        },
        50,
      );

      console.log(`Done - deleted ${deleted} memberships${failed > 0 ? `, ${failed} failed` : ""}`);
    },

    async deleteOrg(args) {
      const orgId = args[0];
      if (!orgId) {
        console.log("Usage: deleteOrg <orgId>");
        return;
      }
      await rateLimiters.deleteOrg.acquire();
      await workos.organizations.deleteOrganization(orgId);
      console.log(`Deleted org ${orgId}`);
    },

    async deleteUser(args) {
      const userId = args[0];
      if (!userId) {
        console.log("Usage: deleteUser <userId>");
        return;
      }
      await rateLimiters.userWrite.acquire();
      await workos.userManagement.deleteUser(userId);
      console.log(`Deleted user ${userId}`);
    },

    async config() {
      console.log(`API Key: ${apiKey!.slice(0, 10)}...`);
      console.log(`Email: ${email}`);
      console.log(
        `Users created as: ${generateEmail(1)}, ${generateEmail(2)}, ...`,
      );
    },

    async help() {
      console.log(`
Commands:
  createOrgs <num>              Create orgs named Organization 1, 2, 3, etc.
  createUsers <num> [orgId]     Create users (optionally add to org)
  createOrgMembership <userId>  Add a user to ALL organizations
  listOrgs                      List all organizations
  listUsers [orgId]             List users (optionally by org)
  deleteAllUsers                Delete ALL users (with confirmation)
  deleteAllOrgs                 Delete ALL organizations (with confirmation)
  deleteAllMemberships          Delete ALL org memberships (with confirmation)
  deleteOrg <orgId>             Delete a specific organization
  deleteUser <userId>           Delete a specific user
  config                        Show current config
  help                          Show this help
  exit                          Exit the CLI
`);
    },
  };

  console.log("WorkOS CLI - Type 'help' for commands, 'exit' to quit\n");

  function prompt() {
    rl.question("workos> ", async (line) => {
      const [cmd, ...args] = line.trim().split(/\s+/);

      if (!cmd) {
        prompt();
        return;
      }

      if (cmd === "exit" || cmd === "quit") {
        rl.close();
        process.exit(0);
      }

      const handler = commands[cmd];
      if (handler) {
        try {
          await handler(args);
        } catch (error: any) {
          console.error("Error:", error.message);
        }
      } else {
        console.log(`Unknown command: ${cmd}. Type 'help' for commands.`);
      }

      prompt();
    });
  }

  prompt();
}

main();
