---
name: djinni
description: Use when the user asks to work with a djinni.co job seeker account, for jobs, watches, profile, CV, applications, subscriptions or the inbox.
---

# djinni-mcp CLI

djinni-mcp works with the djinni.co account of the user. Run each command as `npx djinni-mcp <command> --json` and read the JSON result. Never run `npx` with the package name "djinni" alone. That npm package belongs to another maintainer.

Run `npx djinni-mcp --help` for the full command list. Run `npx djinni-mcp <command> --help` for the flags of a command.

## Login

If a command says that the session is not valid, tell the user:

> Run in a separate terminal window: npx djinni-mcp login

The command asks for the email and the password with a hidden input. Never ask the user for the password in the chat. Do not run the login command yourself.

## Rules

1. Never invent facts. Use only the facts from the profile of the user and the facts that the user confirmed. This applies to the profile, the CV and each cover letter.
2. Never copy text from the profiles of other candidates. The candidate profiles are anonymous. Do not try to find out who a candidate is.
3. Follow the draft rule for profile changes, CV uploads, job applications and job subscriptions:
   1. Run the `prepare` command. It sends nothing to djinni.
   2. Show the full draft to the user.
   3. Wait for an explicit approval in the chat.
   4. Run the `submit` command with `--yes` only after that approval.
4. An application cannot be taken back. Do not use `apply submit --resend`. Only the user runs it, in a terminal.
5. djinni-mcp sends at most 15 applications in one Europe/Kyiv day.
6. djinni marks a conversation as read when a client opens it. `inbox read` marks an unread conversation as unread again. Do not add `--mark-read` unless the user asks for it.
7. Run djinni-mcp commands one at a time. Never run them in parallel.

## Commands

Read only:

```sh
npx djinni-mcp whoami --json
npx djinni-mcp jobs search --category python --query "django" --json
npx djinni-mcp jobs get <job> --json
npx djinni-mcp jobs stats <job> --json
npx djinni-mcp jobs similar <job> --json
npx djinni-mcp jobs favorites --json
npx djinni-mcp company <company> --json
npx djinni-mcp candidates search --keywords "python django" --json
npx djinni-mcp candidates get <hash> --json
npx djinni-mcp candidates similar <hash> --json
npx djinni-mcp profile show --json
npx djinni-mcp cv list --json
npx djinni-mcp applications --json
npx djinni-mcp subs options --json
npx djinni-mcp subs list --json
npx djinni-mcp inbox --json
npx djinni-mcp inbox --bucket unread --json
npx djinni-mcp drafts list --json
npx djinni-mcp doctor --json
```

Read a conversation. djinni marks a conversation as read when a client opens it. So this command can send the request that marks an unread conversation as unread again. With `--mark-read`, the conversation stays read:

```sh
npx djinni-mcp inbox read <thread-id> --json
```

Local only (no change on djinni):

```sh
npx djinni-mcp watch add <name> --category python --json
npx djinni-mcp watch list --json
npx djinni-mcp watch check --json
npx djinni-mcp watch rm <id> --json
npx djinni-mcp cv render <file.md> --json
npx djinni-mcp cv import <file.pdf> --json
npx djinni-mcp drafts rm <draft-id> --json
```

Changes on djinni, with the draft rule:

```sh
npx djinni-mcp profile prepare --set key=value --json
npx djinni-mcp profile submit <draft-id> --yes --json
npx djinni-mcp cv prepare <file.pdf> --json
npx djinni-mcp cv submit <draft-id> --yes --json
npx djinni-mcp apply prepare <job> --message-file letter.txt --json
npx djinni-mcp apply submit <draft-id> --yes --json
npx djinni-mcp subs prepare --name <name> --category <value> --json
npx djinni-mcp subs prepare-company <job> --json
npx djinni-mcp subs submit <draft-id> --yes --json
```

Small changes on djinni in one step, without a draft: save or hide a job, and mark a conversation as unread. Run them only when the user asks:

```sh
npx djinni-mcp jobs save <job> --json
npx djinni-mcp jobs unsave <job> --json
npx djinni-mcp jobs hide <job> --json
npx djinni-mcp jobs unhide <job> --json
npx djinni-mcp inbox unread <thread-id> --json
```

## When a command fails

Run `npx djinni-mcp doctor --json`. It sends only GET requests and tells which djinni page or API changed. Tell the user the failed steps.
