// Fixture (warnings-only): bare 501 + placeholder copy.
export function gate(res) {
  // seed:http-501-warn — bare 501 with no unfinished-language alongside it.
  res.status(501).json({ error: "capability disabled on this node" });
  return "queued";
}
