import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import { URL } from 'url';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface RouterConfig {
  name: string;
  homepageUrl: string;
  manufacturer?: string;
  model?: string;
  serial?: string;
  firmwareRevision?: string;
  pollingInterval?: string;
}

export class SimpleRouterStatusPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const routers: RouterConfig[] = this.config.routers || [];

    for (const router of routers) {
      const uuid = this.api.hap.uuid.generate(
        'homepageUrl_' + router.homepageUrl,
      );
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid,
      );
      const accessory =
        existingAccessory ?? new this.api.platformAccessory(router.name, uuid);
      accessory.context.device = router;

      if (existingAccessory) {
        this.log.info(
          'Restoring existing router accessory from cache:',
          existingAccessory.displayName,
        );
      } else {
        this.log.info('Adding new router accessory:', router.name);
      }

      accessory
        .getService(this.Service.AccessoryInformation)!
        .setCharacteristic(
          this.Characteristic.Manufacturer,
          router.manufacturer ?? 'Default-Manufacturer',
        )
        .setCharacteristic(
          this.Characteristic.Model,
          router.model ?? 'Default-Model',
        )
        .setCharacteristic(
          this.Characteristic.SerialNumber,
          router.serial ?? 'Default-Serial',
        )
        .setCharacteristic(
          this.Characteristic.FirmwareRevision,
          router.firmwareRevision ?? '1.0.0',
        );
      const wiFiSatelliteService =
        accessory.getService(this.Service.WiFiSatellite) ||
        accessory.addService(this.Service.WiFiSatellite);
      wiFiSatelliteService.setCharacteristic(
        this.Characteristic.Name,
        router.name,
      );
      wiFiSatelliteService
        .getCharacteristic(this.Characteristic.WiFiSatelliteStatus)
        .onGet(async () => {
          try {
            const status = await this.getRouterStatus(router.homepageUrl);
            return status
              ? this.Characteristic.WiFiSatelliteStatus.CONNECTED
              : this.Characteristic.WiFiSatelliteStatus.NOT_CONNECTED;
          } catch (error) {
            this.log.debug('Error getting router status:', error);
            return this.Characteristic.WiFiSatelliteStatus.NOT_CONNECTED;
          }
        });

      const parsedPollingInterval = parseInt(
        router.pollingInterval ?? 'NaN',
        10,
      );
      const effectivePollingInterval = isNaN(parsedPollingInterval)
        ? 5000
        : parsedPollingInterval;

      // Start polling the router every 5000ms to fetch status and update HomeKit
      setInterval(async () => {
        try {
          const status = await this.getRouterStatus(router.homepageUrl);
          wiFiSatelliteService
            .getCharacteristic(this.Characteristic.WiFiSatelliteStatus)
            .updateValue(
              status
                ? this.Characteristic.WiFiSatelliteStatus.CONNECTED
                : this.Characteristic.WiFiSatelliteStatus.NOT_CONNECTED,
            );
          this.log.debug(
            `Updated router status for ${router.name}: ${status ? 'CONNECTED' : 'NOT_CONNECTED'}`,
          );
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.log.debug(
              `Error auto-updating status for ${router.name}:`,
              error.message,
            );
          } else {
            this.log.debug(
              `Unknown error auto-updating status for ${router.name}.`,
            );
          }
        }
      }, effectivePollingInterval);

      if (!existingAccessory) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }

    for (const accessory of this.accessories) {
      if (
        !routers.some(
          (router) =>
            this.api.hap.uuid.generate('homepageUrl_' + router.homepageUrl) ===
            accessory.UUID,
        )
      ) {
        this.log.info(
          'Removing missing router accessories:',
          routers.find(
            (router) =>
              this.api.hap.uuid.generate(
                'homepageUrl_' + router.homepageUrl,
              ) === accessory.UUID,
          ),
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }
  }

  parseUrl(inputUrl: string): URL {
    // If the URL doesn't start with http:// or https://, assume http
    let url: URL;
    if (!/^https?:\/\//i.test(inputUrl)) {
      url = new URL(`http://${inputUrl}`);
    } else {
      url = new URL(inputUrl);
    }

    // If no port is specified, set the default ports for http/https
    if (!url.port) {
      if (url.protocol === 'http:') {
        url.port = '80';
      } else if (url.protocol === 'https:') {
        url.port = '443';
      }
    }

    return url;
  }

  async getRouterStatus(inputUrl: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const url = this.parseUrl(inputUrl);

      const getModule = url.protocol === 'https:' ? httpsGet : httpGet;

      const requestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        rejectUnauthorized: false, // Ignore SSL certificate errors
      };

      getModule(requestOptions, (res) => {
        if (res.statusCode && res.statusCode >= 400 && res.statusCode < 600) {
          this.log.debug(`Received ${res.statusCode} status from ${url.href}`);
          resolve(false);
        } else {
          this.log.debug(`Successfully fetched status from ${url.href}`);
          resolve(true);
        }
      }).on('error', (error) => {
        this.log.debug(
          `Error fetching status from ${url.href}: ${error.message}`,
        );
        reject(error);
      });
    });
  }
}
