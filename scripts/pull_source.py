"""Bring assets we already own home into R2, from wherever they live.

Founder: *"we have a lot of assets which need to go into R2 to be
reused for stuff - not all created here but belong to us"*, then, on
the first version of this file: *"why do we need a separate thing for
popcorn, why isnt it just url etc - worried why each new thing needs
separate stuff"*.

Correct, and the first version deserved it. Nothing in it was actually
about that vendor — two constants were, and the other four hundred
lines were a generic MCP client. So the vendor moved to a ROW in
api/_assetSources.json (id, url, key names) and this file no longer
knows any vendor exists. Adding the next one is a row.

That is the same shape the rest of the repo already uses: a lane is a
row in _inference/registry.py, not a new gateway. A new FILE should
mean a new PROTOCOL — a source that speaks plain REST would need a
second reader — never a new supplier.

## Why this DISCOVERS the API instead of coding it

Vendor docs are routinely refused by this environment's egress proxy —
a policy denial at the gateway (CONNECT 403), not a TLS problem — so
an adapter written here cannot be written from documentation. The
registry already says what to do about that, next to the fal rows:

    a remembered API shape marked healthy is a paid failure waiting for
    the first person who trusts it

So this asks the server what it can do rather than assuming. MCP has a
discovery call built into the protocol: `initialize` then `tools/list`
returns every tool with its schema. Run `--discover` once and the real
tool names land in api/_sources/; the pull then uses what came back. A
tool name guessed from a search result would be a script that fails in
CI with the key in hand, which is the expensive place to find out.

## Where it runs

In Actions, on the job that holds the credentials. Founder: *"we do
everything via github yml"*. An agent container has neither the keys
nor egress to these hosts, so running it here proves nothing and is
not offered as if it did.

## What it does NOT do

Stamp anybody's branding on anything, per the founder. Provenance is
recorded in the MANIFEST — where an asset came from is a fact worth
keeping and a burden the file itself should not carry.

Run:
  python3 scripts/pull_source.py --source <id> --discover
  python3 scripts/pull_source.py --source <id> --limit 5
  python3 scripts/pull_source.py --source <id> --all
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "api"))

#: Who we say we are. A source behind Cloudflare bans the default
#: `Python-urllib/3.x` on sight, and a request that never arrives looks
#: exactly like a credential that does not work.
USER_AGENT = "OntoldAssetPuller/1.0 (+https://ontold.com; contact@ontold.com)"

#: Where discovery and the pull manifest land. api/_sources/ is where
#: the other "what did we find out there" files live.
OUT_DIR = _ROOT / "api" / "_sources"

#: The table. Every vendor fact lives here and none live in this file.
SOURCES_FILE = _ROOT / "api" / "_assetSources.json"


class Source:
    """One place our assets live: a URL, some key names, a protocol.

    Deliberately thin. If this class ever needs a branch on `id`, the
    thing being added is not a source — it is a protocol, and protocols
    are what earn new code.
    """

    def __init__(self, row: dict):
        self.id = str(row["id"])
        self.protocol = str(row.get("protocol") or "mcp")
        self.key_vars: tuple[str, ...] = tuple(row.get("keyEnv") or ())
        self.base_url = (os.environ.get(str(row.get("baseUrlEnv") or "")) or "").strip() \
            or str(row.get("baseUrl") or "")
        self.note = str(row.get("note") or "")
        if not self.base_url:
            raise RuntimeError(f"source '{self.id}' has no base url")
        if not self.key_vars:
            raise RuntimeError(f"source '{self.id}' names no credential variable")

    def out(self, kind: str) -> Path:
        """Where this source's <kind> file lands: one namespace per
        source, so two of them never overwrite each other's findings."""
        return OUT_DIR / f"{self.id}-{kind}.json"


def load_source(source_id: str) -> Source:
    """A row by id, or a refusal that lists the ids there are."""
    doc = json.loads(SOURCES_FILE.read_text("utf-8"))
    rows = doc.get("sources") or []
    for row in rows:
        if str(row.get("id")) == source_id:
            source = Source(row)
            if source.protocol != "mcp":
                raise RuntimeError(
                    f"source '{source_id}' speaks '{source.protocol}'; only mcp "
                    "is implemented — a new protocol is where new code belongs")
            return source
    known = ", ".join(str(r.get("id")) for r in rows) or "(none)"
    raise KeyError(f"no source '{source_id}' — known: {known}")

#: Fields an MCP result might use for a downloadable file. Listed rather
#: than assumed because the shape is unknown until --discover has run;
#: a result that matches none of these is REPORTED, never skipped.
URL_FIELDS = ("url", "downloadUrl", "download_url", "videoUrl", "video_url",
              "assetUrl", "asset_url", "href", "uri", "outputUrl", "output_url",
              "thumbnailUrl", "thumbnail_url", "imageUrl", "image_url")
ID_FIELDS = ("id", "assetId", "asset_id", "videoId", "video_id", "movieId", "key")

#: The WORDS. Founder: *"we need all our prompts etc"* — and the prompt
#: is the part that is genuinely ours, the thing worth more than the
#: file it produced. A render can be re-run from a prompt; a prompt
#: cannot be recovered from a render. Lifted to the top of each record
#: for readability, but the raw payload is written out whole regardless,
#: so a field spelled in a way this list does not know is still kept.
PROMPT_FIELDS = ("prompt", "brief", "script", "transcript", "instructions",
                 "description", "storyboard", "scenes", "shots", "style",
                 "negativePrompt", "negative_prompt", "voiceover", "narration",
                 "analysis", "logline", "treatment", "caption", "text")


def _rel(path: Path) -> str:
    """A path for a human to read. Falls back to the absolute form when
    it is outside the checkout, so a print never takes the run down."""
    try:
        return str(path.relative_to(_ROOT))
    except ValueError:
        return str(path)


def api_key(source: Source) -> str:
    """The credential, or a refusal that names every variable that would
    fix it — the same courtesy the keyring extends."""
    for var in source.key_vars:
        value = (os.environ.get(var) or "").strip()
        if value:
            return value
    raise RuntimeError(
        f"no {source.id} credential — set one of: " + ", ".join(source.key_vars))


def _rpc(source: Source, method: str, params: dict | None = None, *,
         ident: int = 1, timeout: int = 60) -> dict:
    """One JSON-RPC call to the MCP endpoint.

    Streamable-HTTP MCP servers may answer with either `application/json`
    or an SSE stream, so both are accepted and both are parsed. A body
    that is neither is raised WITH its first bytes attached: unreadable
    is not empty, and a caller that returns {} here would look like a
    server with no tools.
    """
    body = json.dumps({"jsonrpc": "2.0", "id": ident,
                       "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(source.base_url, data=body, method="POST", headers={
        "Authorization": f"Bearer {api_key(source)}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        # Cloudflare in front of a source refuses urllib's default
        # signature outright — Error 1010, browser_signature_banned,
        # before the request ever reaches their API. Saying who we
        # actually are is both the fix and the honest thing to send.
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:400]
        except Exception:                                   # noqa: BLE001
            detail = "<unreadable body>"
        raise RuntimeError(
            f"{source.id} HTTP {exc.code} {exc.reason}: {detail}") from exc
    return _parse(raw)


def _parse(raw: str) -> dict:
    """A JSON body, or the last data: frame of an SSE stream."""
    text = raw.strip()
    if not text:
        raise RuntimeError("source returned an empty body")
    if text.startswith("{"):
        return json.loads(text)
    last: dict | None = None
    for line in text.splitlines():
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk and chunk != "[DONE]":
                try:
                    last = json.loads(chunk)
                except json.JSONDecodeError:
                    continue
    if last is None:
        raise RuntimeError(f"source returned an unreadable body: {text[:200]}")
    return last


def discover(source: Source) -> list[dict]:
    """Every tool the server offers, with its schema, written to disk.

    This is the whole point of running against MCP rather than a REST
    guess: the protocol answers "what can you do" for free.
    """
    _rpc(source, "initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "ontold", "version": "1"},
    })
    result = (_rpc(source, "tools/list", ident=2).get("result") or {})
    tools = result.get("tools") or []
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    source.out("tools").write_text(json.dumps({
        "_note": ("Written by scripts/pull_source.py --discover. The tools the "
                  "server ACTUALLY offers, read from it rather than from "
                  "documentation this environment cannot reach."),
        "source": source.id,
        "tools": tools,
    }, indent=2) + "\n", encoding="utf-8")
    return tools


def listing_tool(tools: list[dict]) -> str | None:
    """Which tool lists what we already own.

    Chosen by reading the server's own names and descriptions, because
    the name is not knowable in advance. Prefers a plain list/library
    call over a search that needs a query.
    """
    def score(tool: dict) -> int:
        """How much this tool looks like the one that lists our work."""
        name = str(tool.get("name") or "").lower()
        desc = str(tool.get("description") or "").lower()
        if any(w in name for w in ("create", "generate", "render", "delete")):
            return -1                       # never call a tool that makes work
        points = 0
        for word, weight in (("list", 3), ("library", 3), ("assets", 2),
                             ("videos", 2), ("movies", 2), ("history", 2),
                             ("projects", 1), ("search", 1)):
            points += weight * (word in name)
            points += (word in desc)
        return points

    ranked = sorted(tools, key=score, reverse=True)
    return str(ranked[0]["name"]) if ranked and score(ranked[0]) > 0 else None


def call_tool(source: Source, name: str, arguments: dict | None = None) -> dict:
    """Invoke one MCP tool and hand back its result block."""
    return (_rpc(source, "tools/call", {"name": name, "arguments": arguments or {}},
                 ident=3).get("result") or {})


def id_argument(tools: list[dict], detail: str) -> str:
    """The argument a detail tool wants the id in, read off its schema.

    Discovery already returned every tool's inputSchema, so which word a
    vendor chose for "id" is something to look up rather than configure.
    """
    for tool in tools:
        if str(tool.get("name")) != detail:
            continue
        props = (tool.get("inputSchema") or {}).get("properties") or {}
        required = (tool.get("inputSchema") or {}).get("required") or list(props)
        for field in required:
            if field in ID_FIELDS or field.endswith(("id", "Id", "_id")):
                return field
        if len(props) == 1:
            return next(iter(props))
    raise RuntimeError(f"{detail} takes no id-shaped argument — check its schema")


def titles_in(result: dict) -> dict[str, str]:
    """id → name, off a listing. The detail call rarely repeats it."""
    named: dict[str, str] = {}

    def walk(node) -> None:
        """Descend one node, keeping any id that came with a name."""
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            text = node["text"].strip()
            if text.startswith(("{", "[")):
                try:
                    walk(json.loads(text))
                except json.JSONDecodeError:
                    pass
        ident = next((str(node[f]) for f in ID_FIELDS
                      if isinstance(node.get(f), str) and node[f].strip()), "")
        title = str(node.get("title") or node.get("name") or "").strip()
        if ident and title:
            named.setdefault(ident, title)
        for value in node.values():
            walk(value)

    walk(result.get("content") if "content" in result else result)
    return named


def ids_in(result: dict) -> list[str]:
    """Every record id in a listing, in the order the server gave them.

    A listing that returns ids and no files (list-then-get) is the common
    shape, and the second call is where the URL lives.
    """
    found: list[str] = []

    def walk(node) -> None:
        """Descend one node, collecting anything that looks like a record id."""
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            text = node["text"].strip()
            if text.startswith(("{", "[")):
                try:
                    walk(json.loads(text))
                except json.JSONDecodeError:
                    pass
        ident = next((str(node[f]) for f in ID_FIELDS
                      if isinstance(node.get(f), str) and node[f].strip()), "")
        if ident and ident not in found:
            found.append(ident)
        for value in node.values():
            walk(value)

    walk(result.get("content") if "content" in result else result)
    return found


def _words(node: dict) -> dict:
    """The writing on one record — prompt, script, scenes, whatever it
    called them. Lifted to the top for readability only; the full record
    travels alongside, so a field spelled in a way PROMPT_FIELDS does
    not know is still kept."""
    out: dict = {}
    for field in PROMPT_FIELDS:
        value = node.get(field)
        if isinstance(value, str) and value.strip():
            out[field] = value.strip()
        elif isinstance(value, (list, dict)) and value:
            out[field] = value
    return out


def assets_in(result: dict) -> list[dict]:
    """Every downloadable thing in a tool result, however it is nested.

    MCP wraps results in a `content` list whose text parts are usually
    JSON strings, so this walks both the envelope and whatever is inside
    it. A dict carrying something that looks like a file URL counts.
    """
    found: list[dict] = []
    seen: set[str] = set()

    def walk(node) -> None:
        """Descend one node of the envelope, collecting any file on it."""
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            text = node["text"].strip()
            if text.startswith(("{", "[")):
                try:
                    walk(json.loads(text))
                except json.JSONDecodeError:
                    pass
        url = next((str(node[f]) for f in URL_FIELDS
                    if isinstance(node.get(f), str) and node[f].strip()), "")
        if url.startswith("http") and url not in seen:
            seen.add(url)
            ident = next((str(node[f]) for f in ID_FIELDS if node.get(f)), "")
            # The record this file sits in, kept WHOLE. The prompt is
            # the part that is actually ours — a render can be re-run
            # from a prompt, and a prompt cannot be recovered from a
            # render — and its field name is not knowable in advance,
            # so nothing is dropped on the way through.
            found.append({"id": ident, "url": url,
                          "title": str(node.get("title") or node.get("name") or ""),
                          "prompt": _words(node),
                          "record": node})
        for value in node.values():
            walk(value)

    walk(result.get("content") if "content" in result else result)
    return found


#: Where a pulled thing is likely to belong, and the words that say so.
#: Founder: *"some of this stuff will go to reaction library or
#: where-ever relevant"*.
#:
#: There is no separate reaction store to write to — a reaction IS an
#: ordinary library item with `remixedFromId` set at the film it answers
#: (components/CameoReel says so in its own docstring), which is why
#: this SORTS and does not seed. The pull proposes a home; a person
#: confirms it. Auto-filing an unverified pull straight into the seed
#: manifest is how the wall came to offer works that do not exist.
DESTINATIONS = (
    ("reactions", ("reaction", "cameo", "react", "response", "duet")),
    ("audio",     ("voice", "narration", "score", "music", "audio", "sfx")),
    ("stills",    ("still", "frame", "poster", "thumbnail", "portrait", "image")),
    ("films",     ("film", "movie", "scene", "episode", "trailer", "video")),
)

#: File extensions that settle it regardless of what the words say.
BY_EXTENSION = {"wav": "audio", "mp3": "audio", "m4a": "audio", "aac": "audio",
                "jpg": "stills", "jpeg": "stills", "png": "stills", "webp": "stills",
                # A finished movie arrived as `output.mp4` under an
                # opaque id, so every word-based rule missed it and
                # nineteen films filed as unsorted.
                "mp4": "films", "mov": "films", "webm": "films"}


def classify(asset: dict) -> str:
    """Which shelf this belongs on, or `unsorted` when it will not say.

    Reads the asset's own title, prompt and URL. `unsorted` is a real
    answer and appears in the manifest as one — a guessed destination is
    worse than an obvious gap, because nobody re-checks a filled field.
    """
    ext, _ = _extension(asset.get("url", ""))
    # A sound file or a picture is settled by its extension: no wording
    # makes a .wav a film. A VIDEO extension is not, because a reaction
    # is a kind of film and only the words say which — so the words get
    # first refusal and the extension catches what they leave.
    if BY_EXTENSION.get(ext) not in (None, "films"):
        return BY_EXTENSION[ext]
    haystack = " ".join(str(asset.get(k) or "") for k in
                        ("title", "id", "url", "prompt")).lower()
    for name, words in DESTINATIONS:
        if any(w in haystack for w in words):
            return name
    return BY_EXTENSION.get(ext, "unsorted")


def _extension(url: str) -> tuple[str, str]:
    """(extension, content type) for a URL, from its path."""
    path = url.split("?", 1)[0]
    ext = Path(path).suffix.lstrip(".").lower() or "mp4"
    return ext, mimetypes.guess_type(path)[0] or "application/octet-stream"


def mirror(source: Source, assets: list[dict]) -> list[dict]:
    """Copy each asset into R2 and record where it landed.

    Provenance goes in the MANIFEST, not into the file: whose pipeline
    made an asset is worth knowing and is not a watermark.
    """
    from _inference import r2_sink                          # noqa: PLC0415

    out: list[dict] = []
    for i, asset in enumerate(assets, start=1):
        ext, content_type = _extension(asset["url"])
        job = f"{source.id}-{asset['id'] or i:0>4}"
        try:
            landed = r2_sink.fetch_and_upload(
                job_id=job, source_url=asset["url"],
                extension=ext, content_type=content_type)
        except Exception as exc:                            # noqa: BLE001
            print(f"[{source.id}] {job} FAILED: {exc}", flush=True)
            out.append({**asset, "error": str(exc)[:200]})
            continue
        print(f"[{source.id}] {job} -> {landed['output_r2_key']} "
              f"({landed.get('size_bytes', 0) // 1024}KB)", flush=True)
        out.append({
            "id": asset["id"], "title": asset["title"],
            "r2Key": landed["output_r2_key"], "url": landed["output_url"],
            "sizeBytes": landed.get("size_bytes"),
            "destination": classify(asset),
            "prompt": asset.get("prompt") or {},
            "record": asset.get("record") or {},
            "sourcedFrom": source.id,
        })
    return out


#: What a pulled destination becomes in the manifest. `unsorted` and
#: `audio` are left out on purpose: a manifest entry is a promise that
#: /api/watch can serve the thing, and neither of those has a kind that
#: means anything to the player yet.
MANIFEST_KIND = {"stills": "image", "reactions": "image", "films": "film"}


def register_pulled(source: Source, landed: list[dict]) -> int:
    """Give each mirrored file a manifest entry, so it can be served.

    Without one there is no `/api/watch?id=`, and a file we hold that
    nothing can request is not an asset. Registering makes a film
    WATCHABLE; it does not put it on any shelf — the wall and the reels
    read their own lists, and where a work belongs stays a person's
    call.
    """
    path = _ROOT / "api" / "seed" / "manifest.json"
    if not path.exists():
        # The pulling job checks out sparsely — api/seed is 720MB it
        # never opens. Say so; a run whose uploads all worked must not
        # go red for a file it chose not to fetch.
        print(f"[{source.id}] no manifest here (sparse checkout) — "
              "stills stay unregistered", flush=True)
        return 0
    manifest = json.loads(path.read_text("utf-8"))
    added = 0
    for asset in landed:
        key = str(asset.get("r2Key") or "")
        kind = MANIFEST_KIND.get(str(asset.get("destination") or ""))
        if asset.get("error") or not key or not kind:
            continue
        asset_id = f"{source.id}-{asset.get('id') or Path(key).stem}"
        if asset_id in manifest:
            continue
        manifest[asset_id] = {
            "title": str(asset.get("title") or asset_id),
            "key": key,
            "kind": kind,
            "access": "public",
            "sourcedFrom": source.id,
        }
        added += 1
    if added:
        path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    return added


def main(argv: list[str] | None = None) -> int:
    """Discover, list, then mirror. Discovery runs on EVERY invocation,
    not just `--discover`, because the tool names are the one thing this
    script refuses to remember."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True,
                    help="id of a row in api/_assetSources.json")
    ap.add_argument("--discover", action="store_true",
                    help="ask the server what it offers, write it, stop")
    ap.add_argument("--tool", default="",
                    help="the listing tool to call (default: pick from discovery)")
    ap.add_argument("--detail", default="",
                    help="tool that fetches one record, when the listing "
                         "returns ids and the file lives on the detail")
    ap.add_argument("--limit", type=int, default=5,
                    help="how many assets to mirror (default 5)")
    ap.add_argument("--all", action="store_true", help="mirror everything found")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be mirrored, copy nothing")
    args = ap.parse_args(argv if argv is not None else sys.argv[1:])

    source = load_source(args.source)
    tools = discover(source)
    print(f"[{source.id}] {len(tools)} tools: "
          f"{', '.join(str(t.get('name')) for t in tools) or '(none)'}", flush=True)
    print(f"[{source.id}] wrote {_rel(source.out('tools'))}", flush=True)
    if args.discover:
        return 0

    name = args.tool or listing_tool(tools)
    if not name:
        print(f"[{source.id}] no tool on this server looks like it lists what we own — "
              f"read {_rel(source.out('tools'))} and pass --tool", flush=True)
        return 1

    print(f"[{source.id}] listing via '{name}'", flush=True)
    raw = call_tool(source, name)
    # The whole answer, verbatim, before anything is interpreted.
    # Founder: *"we need all our prompts etc"* — and a parser written
    # against an API nobody here can read will miss fields. What it
    # misses is still on disk.
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    source.out("library").write_text(json.dumps({
        "_note": ("The raw answer from the listing tool, kept whole. Everything "
                  "else here is derived from it, so a field the parser does not "
                  "know is preserved rather than lost."),
        "source": source.id,
        "listedBy": name,
        "result": raw,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[{source.id}] wrote {_rel(source.out('library'))}", flush=True)
    assets = assets_in(raw)
    if args.detail:
        # List-then-get: the listing gives ids and stages, the file lives
        # on the detail record. Ours are found this way; the browse tool
        # only ever returns the platform's own global set.
        field = id_argument(tools, args.detail)
        ids = ids_in(raw)[:None if args.all else max(args.limit, 0)]
        # The name is on the LISTING and the file is on the detail, so
        # neither call has both — nineteen films landed titleless.
        named = titles_in(raw)
        print(f"[{source.id}] {len(ids)} record(s), fetching each via "
              f"'{args.detail}({field}=…)'", flush=True)
        for record_id in ids:
            try:
                for asset in assets_in(call_tool(source, args.detail,
                                                 {field: record_id})):
                    asset["title"] = asset["title"] or named.get(record_id, "")
                    assets.append(asset)
            except Exception as exc:                        # noqa: BLE001
                print(f"[{source.id}] {record_id}: {exc}", flush=True)
    if not assets:
        print(f"[{source.id}] that tool returned nothing downloadable — "
              "the shape is in the log above, not silently empty", flush=True)
        return 1

    wanted = assets if args.all else assets[:max(args.limit, 0)]
    print(f"[{source.id}] {len(assets)} found, {len(wanted)} to mirror", flush=True)
    if args.dry_run:
        for a in wanted:
            print(f"  {a['id'] or '(no id)':24} {a['title'][:40]:40} {a['url'][:60]}")
        print("dry run — nothing copied.")
        return 0

    landed = mirror(source, wanted)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    source.out("assets").write_text(json.dumps({
        "_note": ("Assets pulled into our own R2 by scripts/pull_source.py. "
                  "These are ours to use; the source is recorded here as "
                  "provenance and is not stamped on the files."),
        "source": source.id,
        "listedBy": name,
        "count": len(landed),
        "assets": landed,
    }, indent=2) + "\n", encoding="utf-8")
    failed = [a for a in landed if a.get("error")]
    print(f"[{source.id}] wrote {_rel(source.out('assets'))}", flush=True)
    registered = register_pulled(source, landed)
    print(f"[{source.id}] {registered} file(s) now servable", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
