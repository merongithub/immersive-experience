#!/usr/bin/env python3
"""serve.py — the dev server, with caching off.

`python3 -m http.server` sends no Cache-Control, so Chrome guesses how long a
file stays fresh from how long ago it last changed, and serves recently edited
ES modules from cache without asking. Change two modules, reload, and the page
runs one new file against one stale one: an import that is not there yet, and
a page stuck on its boot screen with nothing on it to say why.

    python3 tools/serve.py          # http://localhost:8137/
    python3 tools/serve.py 9000
"""

import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
    http.server.ThreadingHTTPServer(("", port), NoCache).serve_forever()
