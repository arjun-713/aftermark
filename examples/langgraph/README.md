# Python LangGraph integration

Wrap customer-operated graph execution and annotate the actual side effect tool.

```python
@aq.tool("hubspot.updateContact")
async def update_contact(contact_id, properties):
    return await customer_hubspot_client.update(contact_id, properties)

with aq.run(outcomes=[expected_contact_update]):
    result = await compiled_graph.ainvoke({"messages": messages})
    aq.message(result["messages"][-1].content)
aq.flush()
```

The contextvar follows awaited nodes. If execution is handed to a separate process or queue, propagate an explicit run ID into a new SDK context. Instrument the actual HTTP tool, rather than marking a graph node as externally verified. Run shutdown must call `close()`. See [LangGraph documentation](https://docs.langchain.com/oss/python/langgraph/overview). No arbitrary customer graph runs on platform workers.
