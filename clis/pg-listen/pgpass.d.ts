declare module "pgpass" {
  type Connection = {
    host: string;
    port: number;
    database: string;
    user: string;
  };

  function pgPass(
    connection: Connection,
    callback: (password: string | undefined) => void,
  ): void;

  export default pgPass;
}
