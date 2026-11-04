/** A migration read as text, for the test that runs it against rows in the old shape. */
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
