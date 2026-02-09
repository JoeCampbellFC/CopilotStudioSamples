import sql from "mssql";
const DEFAULT_JDBC = "jdbc:sqlserver://insightplus.database.windows.net:1433;database=staging-area;user=mcp_user;password=Password1!;loginTimeout=30";
const JDBC_PREFIX = "jdbc:sqlserver://";
const parseBoolean = (value) => {
    if (value === undefined)
        return undefined;
    return value.toLowerCase() === "true";
};
const getParam = (params, ...keys) => {
    for (const k of keys) {
        const v = params.get(k.toLowerCase());
        if (v !== undefined)
            return v;
    }
    return undefined;
};
const parseJdbcConnectionString = (jdbc) => {
    const normalized = jdbc.startsWith(JDBC_PREFIX) ? jdbc.slice(JDBC_PREFIX.length) : jdbc;
    const [hostPort, ...rest] = normalized.split(";").filter(Boolean);
    const [server, portString] = hostPort.split(":");
    const params = new Map();
    for (const segment of rest) {
        const [rawKey, ...valueParts] = segment.split("=");
        if (!rawKey || valueParts.length === 0)
            continue;
        params.set(rawKey.toLowerCase(), valueParts.join("="));
    }
    const database = getParam(params, "database");
    const user = getParam(params, "user", "userid", "user id");
    const password = getParam(params, "password");
    const encrypt = parseBoolean(getParam(params, "encrypt")) ?? true;
    const trustServerCertificate = parseBoolean(getParam(params, "trustservercertificate")) ?? false;
    const authentication = getParam(params, "authentication");
    // Some JDBC strings include these; @types/mssql wants them for AAD password auth
    const tenantId = getParam(params, "tenantid", "aadtenantid") ?? process.env.AZURE_TENANT_ID ?? process.env.AAD_TENANT_ID;
    const clientId = getParam(params, "clientid", "aadclientid") ?? process.env.AZURE_CLIENT_ID ?? process.env.AAD_CLIENT_ID;
    const config = {
        server,
        port: portString ? Number(portString) : undefined,
        database,
        options: {
            encrypt,
            trustServerCertificate,
            // NOTE: hostNameInCertificate is not in mssql IOptions types; omit it.
        },
    };
    const authIsAadPassword = authentication?.toLowerCase() === "activedirectorypassword";
    if (authIsAadPassword && user && password && tenantId && clientId) {
        config.authentication = {
            type: "azure-active-directory-password",
            options: {
                userName: user,
                password,
                tenantId,
                clientId,
            },
        };
    }
    else {
        // Fallback to SQL auth
        config.user = user;
        config.password = password;
    }
    return config;
};
const jdbcConnectionString = process.env.DATABASE_JDBC_URL ?? process.env.DATABASE_URL ?? DEFAULT_JDBC;
const config = parseJdbcConnectionString(jdbcConnectionString);
let poolPromise;
export const getPool = async () => {
    if (!poolPromise) {
        poolPromise = sql.connect(config);
    }
    return poolPromise;
};
export { sql };
