import sql from 'mssql';

const DEFAULT_JDBC =
  'jdbc:sqlserver://insightplus.database.windows.net:1433;database=staging-area;user={your_username_here};password={your_password_here};encrypt=true;trustServerCertificate=false;hostNameInCertificate=*.database.windows.net;loginTimeout=30;authentication=ActiveDirectoryPassword';

const JDBC_PREFIX = 'jdbc:sqlserver://';

const parseBoolean = (value?: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return value.toLowerCase() === 'true';
};

const parseJdbcConnectionString = (jdbc: string): sql.config => {
  const normalized = jdbc.startsWith(JDBC_PREFIX) ? jdbc.slice(JDBC_PREFIX.length) : jdbc;
  const [hostPort, ...rest] = normalized.split(';').filter(Boolean);
  const [server, portString] = hostPort.split(':');

  const params = new Map<string, string>();
  rest.forEach((segment) => {
    const [rawKey, ...valueParts] = segment.split('=');
    if (!rawKey || valueParts.length === 0) {
      return;
    }
    params.set(rawKey.toLowerCase(), valueParts.join('='));
  });

  const database = params.get('database');
  const user = params.get('user') ?? params.get('userid') ?? params.get('user id');
  const password = params.get('password');
  const encrypt = parseBoolean(params.get('encrypt')) ?? true;
  const trustServerCertificate =
    parseBoolean(params.get('trustservercertificate')) ?? false;
  const hostNameInCertificate = params.get('hostnameincertificate');
  const authentication = params.get('authentication');

  const config: sql.config = {
    server,
    port: portString ? Number(portString) : undefined,
    database,
    options: {
      encrypt,
      trustServerCertificate,
      hostNameInCertificate,
    },
  };

  if (authentication?.toLowerCase() === 'activedirectorypassword') {
    config.authentication = {
      type: 'azure-active-directory-password',
      options: {
        userName: user ?? '',
        password: password ?? '',
      },
    };
  } else {
    config.user = user;
    config.password = password;
  }

  return config;
};

const jdbcConnectionString =
  process.env.DATABASE_JDBC_URL ?? process.env.DATABASE_URL ?? DEFAULT_JDBC;

const config = parseJdbcConnectionString(jdbcConnectionString);

let poolPromise: Promise<sql.ConnectionPool> | undefined;

export const getPool = async (): Promise<sql.ConnectionPool> => {
  if (!poolPromise) {
    poolPromise = sql.connect(config);
  }
  return poolPromise;
};

export { sql };
