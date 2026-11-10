# djinni-mcp

djinni-mcp is a local tool for job seekers on [djinni.co](https://djinni.co). It lets an AI agent, or you in a terminal, work with your own djinni account.

With djinni-mcp you can:

- search jobs, read a job and its applicant statistics, and save or hide jobs
- keep job watches on your computer and check them for new jobs
- compare your profile with the anonymous profiles of other candidates
- change your profile, render a CV to PDF and upload it
- prepare and send job applications with a cover letter
- make djinni job subscriptions
- read your inbox

djinni-mcp is not affiliated with djinni. It is not an official djinni integration.

## Two front ends

djinni-mcp has one core and two front ends:

- **The MCP server.** An AI agent, for example Claude Code or Claude Desktop, uses the djinni tools. The server starts when you run `djinni-mcp` without arguments.
- **The CLI.** You run the same operations in a terminal: `npx djinni-mcp <command>`. After a global install (`npm install -g djinni-mcp`), the short name `djinni <command>` also works.

Run `npx djinni-mcp --help` for the full command list. Run `npx djinni-mcp <command> --help` for the flags of a command.

Always use the package name `djinni-mcp` with `npx`. The npm package with the name "djinni" belongs to another maintainer.

## Install

djinni-mcp needs Node.js 22 or later.

### Claude Code

```sh
claude mcp add djinni -- npx -y djinni-mcp
```

### Claude Desktop

Add this block to the Claude Desktop configuration file (`claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "djinni": {
      "command": "npx",
      "args": ["-y", "djinni-mcp"]
    }
  }
}
```

### From a local copy

```sh
npm install
npm run build
claude mcp add djinni -- node /path/to/djinni-mcp/dist/index.js
```

### The Claude Code skill

The package has a Claude Code skill in the `skill/` folder. The skill tells Claude Code how to use the CLI with the draft rule. To install it, copy the folder to `~/.claude/skills/djinni/`.

From a local copy:

```sh
mkdir -p ~/.claude/skills/djinni
cp -R skill/. ~/.claude/skills/djinni/
```

After a global install (`npm install -g djinni-mcp`):

```sh
mkdir -p ~/.claude/skills/djinni
cp -R "$(npm root -g)/djinni-mcp/skill/." ~/.claude/skills/djinni/
```

## Log in

Run this command in a separate terminal window:

```sh
npx djinni-mcp login
```

The command asks for your djinni email and password. The password input is hidden. The password does not go through the AI agent. djinni-mcp saves only the session on your computer, not the password.

Other login options:

- `npx djinni-mcp login --cookie` asks for the value of the `sessionid` cookie of djinni.co. Copy the value from your browser after you log in on djinni.co.
- `npx djinni-mcp login --browser` opens a browser window for the login. This option needs Playwright. Playwright is an optional dependency of djinni-mcp, and npm installs it by default. Without Playwright, log in with the email and password or with `--cookie`.

Check the session with `npx djinni-mcp whoami`.

## The draft rule

These actions change your djinni account in two steps: profile changes, CV uploads, job applications and job subscriptions. For each of them:

1. A `prepare` step makes a draft on your computer. It sends nothing to djinni.
2. djinni-mcp shows you the full draft: the profile diff, the CV file, the cover letter or the subscription.
3. You give an explicit approval.
4. A `submit` step sends the approved draft to djinni.

In the CLI, `submit` prints the draft and asks `[y/N]`. In an AI agent, the agent must show you the draft and wait for your approval in the chat. A draft expires after 24 hours.

These small actions have one step and no draft: save or unsave a job, hide or unhide a job, and mark a conversation as unread. Reading a conversation can also send the request that marks it as unread again (see the inbox below).

An application cannot be taken back. If djinni gave an unclear answer to an application, djinni may have received it. You can send that application again only from the CLI, with `npx djinni-mcp apply submit <draft-id> --resend`. The command checks the job on djinni first and always asks you.

djinni-mcp sends at most 15 applications in one day (Europe/Kyiv time).

## Main CLI commands

| Command | What it does |
|---|---|
| `login`, `whoami` | Log in and show the logged-in candidate. |
| `jobs search --category python --query "django"` | Search jobs. |
| `jobs get <job>`, `jobs stats <job>`, `jobs similar <job>` | Read a job, its applicant statistics and the similar jobs. |
| `jobs save <job>`, `jobs hide <job>`, `jobs favorites` | Save and hide jobs, and list the saved jobs. |
| `company <company>` | Read a company and its open jobs. |
| `watch add <name> --category python`, `watch check` | Save a job watch and check the watches for new jobs. |
| `candidates search --keywords "python django"`, `candidates get <hash>` | Read the anonymous candidate profiles. |
| `profile show`, `profile prepare --set key=value`, `profile submit <draft-id>` | Read and change your profile. |
| `cv render <file.md>`, `cv import <file.pdf>`, `cv prepare <file.pdf>`, `cv submit <draft-id>` | Make, import and upload a CV. |
| `apply prepare <job> --message-file letter.txt`, `apply submit <draft-id>` | Prepare and send an application. |
| `applications` | List the applications that djinni-mcp sent. |
| `subs options`, `subs prepare --name <name>`, `subs submit <draft-id>` | Make a djinni job subscription. |
| `inbox`, `inbox read <thread-id>`, `inbox unread <thread-id>` | Read your inbox. |
| `drafts list`, `drafts rm <draft-id>` | List and delete the drafts. |
| `doctor` | Check the session and the djinni pages that the tool reads. |

Add `--json` to a command to get the result as JSON.

djinni marks a conversation as read when you open it. `inbox read` marks an unread conversation as unread again after it reads it. Add `--mark-read` to let it stay read.

## MCP prompts

The MCP server has three prompts for the main workflows:

- `adapt-profile`: compare your profile with 10 to 20 candidates for a role and propose a profile change.
- `tailor-cv-and-apply`: adapt your CV and write a cover letter for one job, from true facts only.
- `daily-job-scan`: check your job watches and rank the new jobs against your profile.

## Local data

djinni-mcp keeps its data in `~/.djinni-mcp`. Set the `DJINNI_MCP_HOME` environment variable to use a different folder.

| Path | Content |
|---|---|
| `state.json` | The djinni session. |
| `drafts/` | The drafts that wait for your approval. |
| `cv/` | The CV files. |
| `watches.json`, `seen.json` | The job watches and the jobs that you saw. |
| `applications.json` | The log of the applications that djinni-mcp sent. |
| `locks/` | The lock that lets only one application submit run at a time, and the time of the last request to djinni. All processes that use this folder keep the pause between two requests. |

Only your user can read the folder (mode 0700) and the JSON files in it (mode 0600).

The MCP CV tools read and write only files in the `cv/` folder. To use your own PDF file with an AI agent, copy it into this folder first:

```sh
npx djinni-mcp cv import <file.pdf>
```

## Risks

Read this section before you use djinni-mcp.

- **Account block.** djinni has an anti-bot check. djinni can block an account for spam or for false profile data. djinni-mcp sends one request at a time, with a pause between requests. Do not send many applications that are the same. Do not put false facts in your profile, your CV or a cover letter.
- **Closed pages.** The `robots.txt` file of djinni closes the `/developers` and `/q` pages to robots. djinni-mcp reads these pages only with your own session, and only for your own analysis. Do not use it to collect candidate data.
- **Page changes.** djinni-mcp reads the HTML pages of djinni. djinni can change a page at any time, and then a parser can stop working. If a tool gives an unexpected result, run `npx djinni-mcp doctor`. The doctor sends only GET requests and tells which page changed.

## License

MIT
