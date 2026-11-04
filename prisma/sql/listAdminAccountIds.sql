-- Local accounts whose Better Auth user holds the admin role (roles are comma-separated).
SELECT a.id
FROM accounts a
JOIN "user" u ON u.id = a.auth_user_id
WHERE (',' || REPLACE(u.role, ' ', '') || ',') LIKE '%,admin,%'
ORDER BY a.id
