#!/usr/bin/env python3
"""Tiny static server for Apogee (no caching, so edits show up immediately)."""
import http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128   # the page asks for ~25 modules at once; the default backlog of 5 drops some
    daemon_threads = True

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
print(f'Apogee running at http://localhost:{port}')
Server(('127.0.0.1', port), Handler).serve_forever()
