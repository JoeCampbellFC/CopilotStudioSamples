import sql from "mssql";
export declare const getPool: () => Promise<sql.ConnectionPool>;
export { sql };
