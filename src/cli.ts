import { config } from "dotenv";
import { createInterface } from "readline";
import { writeFileSync } from "fs";
import { WorkOS } from "@workos-inc/node";

config();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function confirm(message: string): Promise<boolean> {
  const answer = await question(`${message} (y/n): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function setup(): Promise<{ apiKey: string; emailTemplate: string }> {
  console.log("\n=== WorkOS CLI Setup ===\n");

  const apiKey = await question("Enter your WorkOS API key: ");
  if (!apiKey.trim()) {
    console.error("API key is required");
    process.exit(1);
  }

  console.log(
    "\nEnter your email template. Use {n} where the number should go.",
  );
  console.log(
    "Example: james+{n}@mokta.co will create james+1@mokta.co, james+2@mokta.co, etc.\n",
  );
  const emailTemplate = await question("Email template: ");
  if (!emailTemplate.includes("{n}")) {
    console.error("Email template must include {n} for the number");
    process.exit(1);
  }

  const envContent = `WORKOS_API_KEY=${apiKey.trim()}\nEMAIL_TEMPLATE=${emailTemplate.trim()}\n`;
  writeFileSync(".env", envContent);
  console.log("\nConfig saved to .env\n");

  return { apiKey: apiKey.trim(), emailTemplate: emailTemplate.trim() };
}

async function main() {
  let apiKey = process.env.WORKOS_API_KEY;
  let emailTemplate = process.env.EMAIL_TEMPLATE;

  if (!apiKey || !emailTemplate) {
    const cfg = await setup();
    apiKey = cfg.apiKey;
    emailTemplate = cfg.emailTemplate;
  }

  const workos = new WorkOS(apiKey);

  function generateEmail(n: number): string {
    return emailTemplate!.replace("{n}", String(n));
  }

  // Helper to count all users
  async function countUsers(): Promise<number> {
    let count = 0;
    let after: string | undefined;
    while (true) {
      const { data: users, listMetadata } =
        await workos.userManagement.listUsers({ after, limit: 100 });
      count += users.length;
      if (!listMetadata?.after) break;
      after = listMetadata.after;
    }
    return count;
  }

  // Helper to count all orgs
  async function countOrgs(): Promise<number> {
    let count = 0;
    let after: string | undefined;
    while (true) {
      const { data: orgs, listMetadata } =
        await workos.organizations.listOrganizations({ after, limit: 100 });
      count += orgs.length;
      if (!listMetadata?.after) break;
      after = listMetadata.after;
    }
    return count;
  }

  // Helper to count all memberships
  async function countMemberships(): Promise<number> {
    let count = 0;
    let after: string | undefined;
    while (true) {
      const { data: memberships, listMetadata } =
        await workos.userManagement.listOrganizationMemberships({
          after,
          limit: 100,
        });
      count += memberships.length;
      if (!listMetadata?.after) break;
      after = listMetadata.after;
    }
    return count;
  }

  const commands: Record<string, (args: string[]) => Promise<void>> = {
    async createOrgs(args) {
      const count = parseInt(args[0], 10);
      if (isNaN(count) || count < 1) {
        console.log("Usage: createOrgs <num>");
        return;
      }
      for (let i = 1; i <= count; i++) {
        try {
          const org = await workos.organizations.createOrganization({
            name: `Organization ${i}`,
          });
          console.log(`Created org "${org.name}" (${org.id})`);
        } catch (error: any) {
          console.error(`Failed to create org "${i}":`, error.message);
        }
      }
    },

    async createUsers(args) {
      const count = parseInt(args[0], 10);
      const orgId = args[1];
      if (isNaN(count) || count < 1 || !orgId) {
        console.log("Usage: createUsers <num> <orgId>");
        return;
      }
      for (let i = 1; i <= count; i++) {
        try {
          const email = generateEmail(i);
          const user = await workos.userManagement.createUser({
            email,
            firstName: email.split("@")[0],
            lastName: String(i),
          });
          await workos.userManagement.createOrganizationMembership({
            userId: user.id,
            organizationId: orgId,
          });
          console.log(`Created ${email} (${user.id})`);
        } catch (error: any) {
          console.error(`Failed to create ${generateEmail(i)}:`, error.message);
        }
      }
    },

    async listOrgs() {
      let count = 0;
      let after: string | undefined;

      while (true) {
        const { data: orgs, listMetadata } =
          await workos.organizations.listOrganizations({ after, limit: 100 });
        if (orgs.length === 0) break;
        for (const org of orgs) {
          console.log(`${org.name} (${org.id})`);
          count++;
        }
        if (!listMetadata?.after) break;
        after = listMetadata.after;
      }

      if (count === 0) {
        console.log("No organizations found");
      }
    },

    async listUsers(args) {
      const orgId = args[0];
      let count = 0;
      let after: string | undefined;

      if (orgId) {
        while (true) {
          const { data: memberships, listMetadata } =
            await workos.userManagement.listOrganizationMemberships({
              organizationId: orgId,
              after,
              limit: 100,
            });
          if (memberships.length === 0) break;
          for (const m of memberships) {
            const user = await workos.userManagement.getUser(m.userId);
            console.log(`${user.email} (${user.id})`);
            count++;
          }
          if (!listMetadata?.after) break;
          after = listMetadata.after;
        }
      } else {
        while (true) {
          const { data: users, listMetadata } =
            await workos.userManagement.listUsers({ after, limit: 100 });
          if (users.length === 0) break;
          for (const user of users) {
            console.log(`${user.email} (${user.id})`);
            count++;
          }
          if (!listMetadata?.after) break;
          after = listMetadata.after;
        }
      }

      if (count === 0) {
        console.log("No users found");
      }
    },

    async deleteAllUsers() {
      const total = await countUsers();
      if (total === 0) {
        console.log("No users found");
        return;
      }

      console.log(`\nFound ${total} users to delete.`);
      if (!(await confirm("Are you sure you want to delete all users?"))) {
        console.log("Cancelled");
        return;
      }

      let deleted = 0;
      let after: string | undefined;

      while (true) {
        const { data: users, listMetadata } =
          await workos.userManagement.listUsers({ after, limit: 100 });
        if (users.length === 0) break;

        for (const user of users) {
          try {
            await workos.userManagement.deleteUser(user.id);
            deleted++;
            console.log(`Deleted ${user.email}`);
          } catch (error: any) {
            console.error(`Failed to delete ${user.email}:`, error.message);
          }
        }

        if (!listMetadata?.after) break;
        after = listMetadata.after;
      }

      console.log(`Done - deleted ${deleted} users`);
    },

    async deleteAllOrgs() {
      const total = await countOrgs();
      if (total === 0) {
        console.log("No organizations found");
        return;
      }

      console.log(`\nFound ${total} organizations to delete.`);
      if (
        !(await confirm("Are you sure you want to delete all organizations?"))
      ) {
        console.log("Cancelled");
        return;
      }

      let deleted = 0;
      let after: string | undefined;

      while (true) {
        const { data: orgs, listMetadata } =
          await workos.organizations.listOrganizations({ after, limit: 100 });
        if (orgs.length === 0) break;

        for (const org of orgs) {
          try {
            await workos.organizations.deleteOrganization(org.id);
            deleted++;
            console.log(`Deleted org "${org.name}"`);
          } catch (error: any) {
            console.error(`Failed to delete org "${org.name}":`, error.message);
          }
        }

        if (!listMetadata?.after) break;
        after = listMetadata.after;
      }

      console.log(`Done - deleted ${deleted} organizations`);
    },

    async deleteAllMemberships() {
      const total = await countMemberships();
      if (total === 0) {
        console.log("No memberships found");
        return;
      }

      console.log(`\nFound ${total} memberships to delete.`);
      if (
        !(await confirm("Are you sure you want to delete all memberships?"))
      ) {
        console.log("Cancelled");
        return;
      }

      let deleted = 0;
      let after: string | undefined;

      while (true) {
        const { data: memberships, listMetadata } =
          await workos.userManagement.listOrganizationMemberships({
            after,
            limit: 100,
          });
        if (memberships.length === 0) break;

        for (const m of memberships) {
          try {
            await workos.userManagement.deleteOrganizationMembership(m.id);
            deleted++;
            console.log(`Deleted membership ${m.id}`);
          } catch (error: any) {
            console.error(
              `Failed to delete membership ${m.id}:`,
              error.message,
            );
          }
        }

        if (!listMetadata?.after) break;
        after = listMetadata.after;
      }

      console.log(`Done - deleted ${deleted} memberships`);
    },

    async deleteOrg(args) {
      const orgId = args[0];
      if (!orgId) {
        console.log("Usage: deleteOrg <orgId>");
        return;
      }
      await workos.organizations.deleteOrganization(orgId);
      console.log(`Deleted org ${orgId}`);
    },

    async deleteUser(args) {
      const userId = args[0];
      if (!userId) {
        console.log("Usage: deleteUser <userId>");
        return;
      }
      await workos.userManagement.deleteUser(userId);
      console.log(`Deleted user ${userId}`);
    },

    async config() {
      console.log(`API Key: ${apiKey!.slice(0, 10)}...`);
      console.log(`Email Template: ${emailTemplate}`);
    },

    async help() {
      console.log(`
Commands:
  createOrgs <num>          Create orgs named 1, 2, 3, etc.
  createUsers <num> <orgId> Create users with your email template
  listOrgs                  List all organizations
  listUsers [orgId]         List users (optionally by org)
  deleteAllUsers            Delete ALL users (with confirmation)
  deleteAllOrgs             Delete ALL organizations (with confirmation)
  deleteAllMemberships      Delete ALL org memberships (with confirmation)
  deleteOrg <orgId>         Delete a specific organization
  deleteUser <userId>       Delete a specific user
  config                    Show current config
  help                      Show this help
  exit                      Exit the CLI
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
