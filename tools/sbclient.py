"""Minimal Supabase client for the admin tools. Uses the service-role key, which bypasses row-level security.
Keep that key on your own machine (environment variables); it must never go into web/ or the repository."""
import os
import sys
from urllib.parse import quote

import requests


class SB:
    def __init__(self):
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        self.domain = os.environ.get("ID_DOMAIN", "study.example.org")
        if not self.url or not self.key:
            sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY (Supabase > Project settings > API > service_role).")
        self.h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}

    def _check(self, r):
        if not r.ok:
            raise RuntimeError(f"{r.request.method} {r.url.split('?')[0]} -> {r.status_code}: {r.text[:400]}")
        return r

    # ---- tables
    def select(self, table, params=None, page=1000):
        out, off = [], 0
        while True:
            r = self._check(requests.get(f"{self.url}/rest/v1/{table}", headers={**self.h, "Range-Unit": "items"},
                                         params={**(params or {}), "limit": page, "offset": off}))
            rows = r.json()
            out += rows
            if len(rows) < page:
                return out
            off += page

    def insert(self, table, rows, upsert=False):
        if not rows:
            return
        h = {**self.h, "Content-Type": "application/json", "Prefer": "return=minimal" + (",resolution=merge-duplicates" if upsert else "")}
        self._check(requests.post(f"{self.url}/rest/v1/{table}", headers=h, json=rows))

    def update(self, table, match, values):
        h = {**self.h, "Content-Type": "application/json", "Prefer": "return=minimal"}
        self._check(requests.patch(f"{self.url}/rest/v1/{table}", headers=h, params=match, json=values))

    # ---- storage
    def upload(self, bucket, path, data, content_type="application/octet-stream"):
        h = {**self.h, "Content-Type": content_type, "x-upsert": "true"}
        self._check(requests.post(f"{self.url}/storage/v1/object/{bucket}/{quote(path)}", headers=h, data=data))

    def download(self, bucket, path):
        return self._check(requests.get(f"{self.url}/storage/v1/object/{bucket}/{quote(path)}", headers=self.h)).content

    # ---- auth
    def email(self, clinician_id):
        return f"{clinician_id.strip().lower()}@{self.domain}"

    def create_user(self, clinician_id, password):
        r = self._check(requests.post(f"{self.url}/auth/v1/admin/users", headers={**self.h, "Content-Type": "application/json"},
                                      json={"email": self.email(clinician_id), "password": password, "email_confirm": True}))
        return r.json()["id"]

    def set_password(self, user_id, password):
        self._check(requests.put(f"{self.url}/auth/v1/admin/users/{user_id}",
                                 headers={**self.h, "Content-Type": "application/json"}, json={"password": password}))
