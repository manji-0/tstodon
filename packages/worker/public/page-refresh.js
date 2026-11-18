// @ts-check
// Reloads a page that waits on queued work, such as an import
// (server/data-pages.ts): a script file, as the content security policy runs
// no inline script.
setTimeout(() => location.reload(), 5000);
