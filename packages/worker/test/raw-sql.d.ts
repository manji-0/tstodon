/** A SQL file read as text, for the tests that run a query or read its plan. */
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
