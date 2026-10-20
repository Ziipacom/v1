import test from "node:test";
import assert from "node:assert/strict";
import {
  adminPagePath,
  canAdmin,
  isAdminIdentity,
  type AdminIdentity,
} from "../src/lib/admin-access.ts";

const member: AdminIdentity = {
  user_id: 7,
  role: "member",
  permissions: [],
  owner_protected: true,
};

test("ordinary accounts and malformed capability responses never unlock administration", () => {
  assert.equal(canAdmin(null, "users.read"), false);
  assert.equal(
    canAdmin({ ...member, permissions: ["users.read"] }, "users.read"),
    false,
  );
  for (const value of [
    null,
    {},
    { ...member, user_id: 0 },
    { ...member, user_id: "7" },
    { ...member, role: "superadmin" },
    { ...member, permissions: "users.read" },
    { ...member, permissions: ["users.read", null] },
    { ...member, owner_protected: "yes" },
  ]) {
    assert.equal(isAdminIdentity(value), false);
    assert.equal(canAdmin(value as AdminIdentity, "users.read"), false);
  }
});

test("staff controls require the exact capability in the current server response", () => {
  const moderator: AdminIdentity = {
    ...member,
    role: "moderator",
    permissions: ["content.read", "reports.triage"],
  };
  assert.equal(canAdmin(moderator, "content.read"), true);
  assert.equal(canAdmin(moderator, "users.read"), false);
  const administrator: AdminIdentity = {
    ...member,
    role: "admin",
    permissions: ["users.read", "users.suspend"],
  };
  assert.equal(canAdmin(administrator, "users.suspend"), true);
  assert.equal(canAdmin(administrator, "roles.write"), false);
  const owner: AdminIdentity = {
    ...member,
    role: "owner",
    permissions: ["roles.write"],
  };
  assert.equal(canAdmin(owner, "roles.write"), true);
  assert.equal(canAdmin({ ...owner, permissions: [] }, "roles.write"), false);
});

test("a subsequent revocation response does not retain earlier owner capability", () => {
  const before: AdminIdentity = {
    ...member,
    role: "owner",
    permissions: ["roles.write"],
  };
  assert.equal(canAdmin(before, "roles.write"), true);
  assert.equal(canAdmin({ ...member }, "roles.write"), false);
});

test("search data remains a query value and cannot change the administrative endpoint or filters", () => {
  const hostile = "a&status=all#https://elsewhere.test/api/admin/users";
  const url = new URL(adminPagePath("users", 2, hostile), "https://ziipa.test");
  assert.equal(url.pathname, "/api/admin/users");
  assert.equal(url.searchParams.get("q"), hostile);
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("page_size"), "25");
  assert.equal(url.searchParams.has("status"), false);
  assert.equal(url.hash, "");
});

test("report views have a bounded page size and explicit status filter", () => {
  const url = new URL(adminPagePath("reports", 1), "https://ziipa.test");
  assert.equal(url.searchParams.get("status"), "open");
  assert.equal(url.searchParams.get("page_size"), "25");
  for (const page of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => adminPagePath("audit", page));
  }
});
