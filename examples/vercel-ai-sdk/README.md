# Vercel AI SDK integration

The SDK is server-only. Wrap each tool's `execute` function and the surrounding invocation. Keep the Vercel AI SDK and model provider in the customer's application.

```ts
const result = await aq.run(async () => {
  const response = await generateText({
    model, prompt,
    tools: {
      createIssue: tool({
        description: 'Create a support issue', inputSchema: issueInputSchema,
        execute: async (args) => aq.tool('github.createIssue', args, () => githubCreateIssue(args)),
      }),
    },
  });
  return response.text;
}, { outcomes: [expectedIssue] });
await aq.flush();
```

`expectedIssue.resource.toolResultField = "number"` can resolve the identifier from a mapped tool result. Configure the repository in the outcome resource and map `github.createIssue` to that outcome in the policy. This is an integration example; a live provider call is not part of the local test suite. See [AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling).
