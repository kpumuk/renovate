import { logger } from '../../../logger/index.ts';
import { withCache } from '../../../util/cache/package/with-cache.ts';
import { Datasource } from '../datasource.ts';
import type { GetReleasesConfig, ReleaseResult } from '../types.ts';
import { datasource } from './common.ts';
import { RpmSqliteMetadataProvider } from './providers/sqlite.ts';
import { RpmXmlMetadataProvider } from './providers/xml.ts';
import {
  type RpmRepositoryMetadata,
  fetchPrimaryGzipUrl,
  fetchRepositoryMetadata,
} from './repomd.ts';

type RpmMetadataSource = 'primary' | 'primary_db';
type ResolvedRpmMetadataSource = 'auto' | RpmMetadataSource;

interface RpmMetadataProvider {
  readonly metadataType: RpmMetadataSource;
  getReleases(
    metadataUrl: string,
    packageName: string,
  ): Promise<ReleaseResult | null>;
}

export class RpmDatasource extends Datasource {
  static readonly id = datasource;

  private readonly providers: Record<RpmMetadataSource, RpmMetadataProvider>;

  constructor() {
    super(RpmDatasource.id);
    const xmlProvider = new RpmXmlMetadataProvider(this.http);
    const sqliteProvider = new RpmSqliteMetadataProvider(this.http);
    this.providers = {
      [xmlProvider.metadataType]: xmlProvider,
      [sqliteProvider.metadataType]: sqliteProvider,
    };
  }

  /**
   * Users are able to specify custom RPM repositories as long as they follow the format.
   * There is a URI http://linux.duke.edu/metadata/common in the <sha>-primary.xml.
   * But according to this post, it's not something we can really look into or reference.
   * @see{https://lists.rpm.org/pipermail/rpm-ecosystem/2015-October/000283.html}
   */
  override readonly customRegistrySupport = true;

  /**
   * Users can specify multiple repositories and the datasource will aggregate the releases
   * @example
   * Every Fedora release has "release" and "updates" repositories.
   * To get the latest package version, these repositories should be aggregated.
   */
  override readonly registryStrategy = 'merge';

  /**
   * Fetches the release information for a given package from the registry URL.
   *
   * @param registryUrl - the registryUrl should be the folder which contains repodata.xml and its corresponding file list <sha256>-primary.xml.gz, e.g.: https://packages.microsoft.com/azurelinux/3.0/prod/cloud-native/x86_64/repodata/
   * @param packageName - the name of the package to fetch releases for.
   * @returns The release result if the package is found, otherwise null.
   */
  private async _getReleases({
    registryUrl,
    packageName,
    rpmMetadataSource,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    if (!registryUrl || !packageName) {
      return null;
    }

    try {
      const metadata = await this.getRepositoryMetadata(registryUrl);
      const metadataSource = this.resolveMetadataSource(rpmMetadataSource);

      if (metadataSource !== 'auto') {
        return await this.getProviderReleases(
          metadataSource,
          metadata,
          packageName,
        );
      }

      return await this.getAutoReleases(metadata, packageName, registryUrl);
    } catch (err) {
      this.handleGenericErrors(err);
    }
  }

  getReleases(config: GetReleasesConfig): Promise<ReleaseResult | null> {
    const metadataSource = this.resolveMetadataSource(config.rpmMetadataSource);

    return withCache(
      {
        namespace: `datasource-${RpmDatasource.id}`,
        key: `${config.registryUrl}:${config.packageName}:${metadataSource}`,
        ttlMinutes: 1440,
        fallback: true,
      },
      () => this._getReleases(config),
    );
  }

  private resolveMetadataSource(
    rpmMetadataSource?: GetReleasesConfig['rpmMetadataSource'],
  ): ResolvedRpmMetadataSource {
    if (rpmMetadataSource === 'primary' || rpmMetadataSource === 'primary_db') {
      return rpmMetadataSource;
    }

    return 'auto';
  }

  private async getAutoReleases(
    metadata: RpmRepositoryMetadata,
    packageName: string,
    registryUrl: string,
  ): Promise<ReleaseResult | null> {
    const { primaryDbUrl, primaryGzipUrl } = metadata;
    let sqliteError: Error | undefined;

    if (primaryDbUrl) {
      try {
        return await this.getProviderReleases(
          'primary_db',
          metadata,
          packageName,
        );
      } catch (err) {
        sqliteError = err instanceof Error ? err : new Error(String(err));
        logger.debug(
          {
            datasource: RpmDatasource.id,
            err,
            packageName,
            registryUrl,
            repodataType: 'primary_db',
            url: primaryDbUrl,
          },
          'Failed to query primary_db metadata, falling back to primary.xml.gz',
        );
      }
    }

    if (primaryGzipUrl) {
      return await this.getProviderReleases('primary', metadata, packageName);
    }

    if (sqliteError) {
      throw sqliteError;
    }

    return null;
  }

  private async getProviderReleases(
    metadataType: RpmMetadataSource,
    metadata: RpmRepositoryMetadata,
    packageName: string,
  ): Promise<ReleaseResult | null> {
    const metadataUrl = this.getMetadataUrl(metadata, metadataType);

    if (!metadataUrl) {
      throw new Error(`No ${metadataType} data found in ${metadata.repomdUrl}`);
    }

    return await this.providers[metadataType].getReleases(
      metadataUrl,
      packageName,
    );
  }

  private getMetadataUrl(
    metadata: RpmRepositoryMetadata,
    metadataType: RpmMetadataSource,
  ): string | undefined {
    return metadataType === 'primary'
      ? metadata.primaryGzipUrl
      : metadata.primaryDbUrl;
  }

  private getRepositoryMetadata(
    registryUrl: string,
  ): Promise<RpmRepositoryMetadata> {
    return withCache(
      {
        namespace: `datasource-${RpmDatasource.id}`,
        key: `repomd:${registryUrl}`,
        ttlMinutes: 1440,
      },
      () => fetchRepositoryMetadata(this.http, registryUrl),
    );
  }

  getPrimaryGzipUrl(registryUrl: string): Promise<string> {
    return withCache(
      {
        namespace: `datasource-${RpmDatasource.id}`,
        key: registryUrl,
        ttlMinutes: 1440,
      },
      () => fetchPrimaryGzipUrl(this.http, registryUrl),
    );
  }

  getReleasesByPackageName(
    primaryGzipUrl: string,
    packageName: string,
  ): Promise<ReleaseResult | null> {
    return this.providers.primary.getReleases(primaryGzipUrl, packageName);
  }
}
