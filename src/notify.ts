import { getInput, setFailed, setOutput } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { WebClient, type KnownBlock } from "@slack/web-api";
import type { ChannelAndBlocks } from "@slack/web-api/dist/types/request/chat";

// Map github to slack usernames
const mapping = parseMapping(getInput("username-mapping"));

// Get Slack client
const token =
  getInput("slack-bot-token") || error("'slack-bot-token' is required");

const slack = new WebClient(token);

const type = getInput("type");

// Validate inputs
if (type === "release") {
  if (!getInput("github-token")) {
    error("'github-token' required for release notifications");
  }
} else if (type == "deployment-success" || type == "deployment-failure") {
  if (!getInput("environment")) {
    error("'environment' is required for deployment notifications");
  }
} else if (type == "staging") {
  // Staging is more flexible, no required fields beyond the common ones
} else {
  error(
    `Invalid notification type '${type}'. Must be: release, deployment-success, deployment-failure, or staging`,
  );
}

const fullRepo = getInput("repository") || error("'repository' is required");
const [owner, repo] = fullRepo.split("/");
if (!owner || !repo) error("'repository' must be in 'owner/repo' form");

const github_user =
  (getInput("actor") as GithubUsername) || error("'actor' is required");
const slack_mention = formatMention(github_user);

const github_token =
  getInput("github-token") || error("'github-token' is required");

const octokit = getOctokit(github_token);

const workflow_url = `https://github.com/${getInput("repository")}/actions/runs/${context.runId}`;

try {
  let contributors = new Set<GithubUsername>();
  const mentions: SlackMention[] = [];

  if (type === "release") {
    const release_tag = getInput("release-tag");
    const release_info = await (release_tag
      ? octokit.rest.repos.getReleaseByTag({
          owner,
          repo,
          tag: release_tag,
        })
      : // Get latest release if no tag specified
        octokit.rest.repos.getLatestRelease({
          owner,
          repo,
        }));
    const current_tag = release_info.data.tag_name;
    const name = release_info.data.name || current_tag;
    const notes = release_info.data.body || "";
    const url = release_info.data.html_url;

    const releases = await octokit.rest.repos.listReleases({
      owner,
      repo,
    });

    const prev_tag_idx =
      releases.data.findIndex((rel) => rel.tag_name === current_tag) + 1;
    const prev_tag = releases.data[prev_tag_idx]?.tag_name;

    contributors = await getContributorsForTagOrRecent(
      octokit,
      current_tag,
      prev_tag,
      { owner, repo },
    );
    for (const contributor of contributors) {
      mentions.push(formatMention(contributor));
    }

    const res = await slack.chat.postMessage(
      messageForReleaseNotification({
        slack_mention,
        notes,
        url,
        name,
      }),
    );

    const channel = res.channel!;
    const timestamp = res.ts!;

    setOutput("thread-ts", timestamp);
    setOutput("channel-id", channel);

    // Add hourglass reaction to release post
    if (getInput("show-progress") == "true") {
      await slack.reactions.add({
        name: "hourglass_flowing_sand",
        channel,
        timestamp,
      });
    }
  }

  if (type == "staging") {
    // Get commits from the current push event
    const push_commits = context.payload.commits as PushCommit[] | undefined;

    // If we have push commits, use them; otherwise fall back to recent commits
    const commits =
      push_commits && push_commits.length
        ? (console.log("Using commits from current push event"), push_commits)
        : (console.log("Falling back to recent commits"),
          await octokit.rest.repos.listCommits({
            owner,
            repo,
            per_page: 5,
          })).data.map((c) => ({
            ...c.commit,
            id: c.sha,
            author: { ...c.commit.author!, username: c.author?.login ?? "" },
          }));
    // Format with GitHub links - clean up commit messages for Slack
    const notes = commits
      .map(
        (e) =>
          `- [${replaceSpecialChars(e.message.split("\n")[0]!)}](https://github.com/${owner}/${repo}/commit/${e.id})`,
      )
      .join("\n");

    function replaceSpecialChars(s: string): string {
      return s
        .replaceAll(/\|/g, "")
        .replaceAll(/</g, "&lt;")
        .replaceAll(/>/g, "&gt;")
        .replaceAll(/\r/g, "");
    }

    contributors = new Set(
      commits.map((c) =>
        c.author!.username || c.author!.email!,
      ) as GithubUsername[],
    );

    // Send staging deployment notification
    await slack.chat.postMessage(
      messageForStagingNotification({
        slack_mention,
        notes,
        contributors,
      }),
    );
  }

  // Add in-progress reaction to original post
  if (type === "deployment-success" || type == "deployment-failure") {
    try {
      await slack.reactions.add({
        channel: getInput("channel-id"),
        timestamp: getInput("thread-ts"),
        name: "hourglass_flowing_sand",
      });
    } catch (e: any) {
      if ((e as any)?.data?.error !== "already_reacted") console.error(e);
    }
  }

  // Remove in-progress reaction from original post
  if (type == "deployment-failure" || type == "deployment-success") {
    try {
      await slack.reactions.remove({
        channel: getInput("channel-id") || getInput("channel"),
        timestamp: getInput("thread-ts"),
        name: "hourglass_flowing_sand",
      });
    } catch (e) {
      console.error(e);
    }
  }

  // Send deployment success notification
  if (type == "deployment-success") {
    try {
      await slack.chat.postMessage({
        channel: getInput("channel-id"),
        thread_ts: getInput("thread-ts"),
        text: `✅ ${context.workflow} successful! <${workflow_url}|View workflow>`,
      });
    } catch (e) {
      console.error(e);
    }

    // Add success reaction to original post
    try {
      await slack.reactions.add({
        channel: getInput("channel-id") || getInput("channel"),
        timestamp: getInput("thread-ts"),
        name: "white_check_mark",
      });
    } catch (e) {
      if ((e as any)?.data?.error !== "already_reacted") console.error(e);
    }
  }

  // Add failure reaction to original post
  if (type == "deployment-failure") {
    try {
      await slack.reactions.add({
        channel: getInput("channel-id") || getInput("channel"),
        timestamp: getInput("thread-ts"),
        name: "x",
      });
    } catch (e) {
      if ((e as any)?.data?.error !== "already_reacted") console.error(e);
    }

    // Send deployment failure notification
    await slack.chat.postMessage({
      channel: getInput("channel-id") || getInput("channel"),
      thread_ts: getInput("thread-ts"),
      reply_broadcast: true,
      text: `❌ ${context.workflow} failed! <${workflow_url}|View workflow>`,
    });
  }
} catch (error) {
  setFailed((error as Error).message);
  throw error;
}

function messageForStagingNotification(inputs: {
  slack_mention: string;
  notes: string;
  contributors: Set<GithubUsername>;
}) {
  const environment = getInput("environment") || "staging";
  const channel = getInput("channel");
  const staging_url = getInput("staging-url");
  const commit_sha = getInput("commit-sha") || context.sha;
  const branch = getInput("branch");
  const repository = getInput("repository");

  const formatted_notes = formatBody(inputs.notes);
  const R: ChannelAndBlocks = {
    channel,
    text: `Staging Updated: ${environment}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🔄 Staging Updated: ${environment}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Repository:*\n${repository}` },
          { type: "mrkdwn", text: `*Environment:*\n\`${environment}\`` },
          { type: "mrkdwn", text: `*Branch:*\n\`${branch}\`` },
          { type: "mrkdwn", text: `*Pushed by:*\n${inputs.slack_mention}` },
        ],
      },
      ...formatted_notes,
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Contributors:*\n${Array.from(inputs.contributors).map(formatMention).join(" ") || "No contributors found"}`,
          },
          { type: "mrkdwn", text: `Commit: \`${commit_sha}\`` },
        ],
      },
      ...(staging_url
        ? [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "View Staging",
                  },
                  url: staging_url,
                },
              ],
            } satisfies KnownBlock,
          ]
        : []),
    ],
  };
  return R;
}

async function getContributorsForTagOrRecent(
  octokit: ReturnType<typeof getOctokit>,
  head: string,
  base: string | undefined,
  opts: { owner: string; repo: string },
): Promise<Set<GithubUsername>> {
  if (base) {
    // Compare commits between tags
    const commits = await octokit.rest.repos.compareCommits({
      ...opts,
      base,
      head,
    });
    const contributors = new Set(
      commits.data.commits
        .map((c) => c.author?.login)
        .filter((e) => !!e)
        .sort() as GithubUsername[],
    );
    return contributors;
  } else {
    // First release - get recent commits
    const commits = await octokit.rest.repos.listCommits({
      ...opts,
      per_page: 10,
    });

    const contributors = new Set(
      commits.data
        .map((c) => c.author?.login)
        .filter((e) => !!e)
        .sort() as GithubUsername[],
    );
    return contributors;
  }
}

function formatMention(github_user: GithubUsername): SlackMention {
  const slack_user = mapping[github_user] ?? github_user;
  return /^U[A-Z0-9]{10}$/.test(slack_user)
    ? (`<@${slack_user}>` as SlackMention)
    : (`@${slack_user}` as SlackMention);
}

interface User {
  email: string;
  name: string;
  username: string;
}

interface PushCommit {
  author: User;
  committer: User;
  distinct: boolean;
  id: string;
  message: string;
  timestamp: string;
  tree_id: string;
  url: string;
}

function parseMapping(s: string): Record<GithubUsername, SlackMention> {
  if (s) return JSON.parse(s);
  return {};
}

type GithubUsername = string & { type: "github" };
type SlackMention = string & { type: "slack" };

function error(s: string): never {
  setFailed(s);
  process.exit(1);
}

function formatBody(s: string): KnownBlock[] {
  //
  // Convert markdown to Slack format
  // Clean up line endings and preserve line breaks
  let cleaned = s.replaceAll(/\r/g, "").replaceAll(/\0/g, "").split("\n");

  const out: KnownBlock[] = [];
  let last: { type: "section"; text: { type: "mrkdwn"; text: string } };

  for (const e of cleaned) {
    // Headings
    const m = /^#+ +(.+?) *$/.exec(e);
    if (m) {
      out.push({ type: "header", text: { type: "plain_text", text: m[1]! } });
      continue;
    }

    if (out.at(-1)?.type != "section" || last!.text.text.length > 2500) {
      last = { type: "section", text: { type: "mrkdwn", text: "" } };
      out.push(last as KnownBlock);
    }

    const repoUrl = `https://github\.com/${owner}/${repo}/`;

    last!.text.text +=
      e
        // Convert headings to bold
        .replaceAll(/^#+ +(.*) *$/g, "*$1*")
        // Convert **bold** to *bold* (Slack uses single asterisks for bold)
        .replaceAll(/\*\*([^*]*)\*\*/g, "*$1*")
        // Convert [link](url) to <url|link>
        .replaceAll(/\[([^]]*)\]\(([^)]*)\)/g, "<$2|$1>")
        // Shorten links that are within-repo
        .replaceAll(
          new RegExp(`\\b${repoUrl}(pull|issue)/([0-9]+)\\b`, "g"),
          (url, _kind, num) => `<${url}|${repo}#${num}>`,
        )
        // Convert GitHub @mentions to Slack mentions using username mapping
        .replaceAll(
          /@([a-zA-Z0-9_-]+)/g,
          function (_: string, u: GithubUsername) {
            return formatMention(u);
          },
        ) +
      "\n";
  }

  return out;
}

function messageForReleaseNotification({
  name,
  slack_mention,
  notes,
  url,
}: {
  name: string;
  slack_mention: SlackMention;
  notes: string;
  url: string;
}) {
  const channel = getInput("channel");
  const branch = getInput("branch") || context.ref;
  const formatted_notes = formatBody(notes);
  const R: ChannelAndBlocks = {
    channel: channel,
    text: `New ${repo} release: ${name}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🚀 New ${repo} release: ${name}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Released by:*\n${slack_mention}` },
          { type: "mrkdwn", text: `*Tag:*\n\`${branch}\`` },
        ],
      },
      ...formatted_notes,
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `SHA: \`${getInput("commit-sha") || context.sha}\``,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "View Release",
            },
            url,
          },
        ],
      },
    ],
  };
  return R;
}
