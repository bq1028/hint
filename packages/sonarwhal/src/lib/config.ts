/**
 * @fileoverview Loads the configuration file
 *
 * Based on ESLint's config-file
 * https://github.com/eslint/eslint/blob/master/lib/config/config-file.js
 */

/* eslint no-use-before-define: 0 */

/*
 * ------------------------------------------------------------------------------
 * Requirements
 * ------------------------------------------------------------------------------
 */

import * as path from 'path';

import * as browserslist from 'browserslist';
import * as shell from 'shelljs';
import * as _ from 'lodash';

import { debug as d } from './utils/debug';
import { UserConfig, IgnoredUrl } from './types';
import { loadJSFile, loadJSONFile } from './utils/misc';
import { validateConfig } from './config/config-validator';
import * as resourceLoader from './utils/resource-loader';

const debug: debug.IDebugger = d(__filename);

/*
 * ------------------------------------------------------------------------------
 * Private
 * ------------------------------------------------------------------------------
 */

const CONFIG_FILES = [
    '.sonarwhalrc',
    '.sonarwhalrc.js',
    '.sonarwhalrc.json',
    'package.json'
];

/** Loads a configuration from a package.json file. */
const loadPackageJSONConfigFile = (filePath: string): UserConfig => {

    debug(`Loading package.json config file: ${filePath}`);

    try {
        return loadJSONFile(filePath).sonarwhalConfig || null;
    } catch (e) {
        debug(`Error reading package.json file: ${filePath}`);
        e.message = `Cannot read config file: ${filePath}\nError: ${e.message}`;
        throw e;
    }
};

/**
 * Loads a configuration file regardless of the source. Inspects the file path
 * to determine the correctly way to load the config file.
 */
const loadConfigFile = (filePath: string): UserConfig => {

    let config: UserConfig;

    switch (path.extname(filePath)) {
        case '':
        case '.json':
            if (path.basename(filePath) === 'package.json') {
                config = loadPackageJSONConfigFile(filePath);
            } else {
                config = loadJSONFile(filePath);
            }
            break;

        case '.js':
            config = loadJSFile(filePath);
            break;

        default:
            config = null;
    }

    return config;
};

const loadBrowsersList = (config: UserConfig) => {
    const directory: string = process.cwd();
    const files: Array<string> = CONFIG_FILES.reduce((total, configFile) => {
        const filename: string = path.join(directory, configFile);

        if (shell.test('-f', filename)) {
            total.push(filename);
        }

        return total;
    }, []);

    for (let i = 0; i < files.length; i++) {
        const file: string = files[i];
        const tmpConfig: UserConfig = loadConfigFile(file);

        if (tmpConfig && tmpConfig.browserslist) {
            config.browserslist = tmpConfig.browserslist;
            break;
        }

        if (file.endsWith('package.json')) {
            const packagejson = loadJSONFile(file);

            config.browserslist = packagejson.browserslist;
        }
    }

    if (!config.browserslist || config.browserslist.length === 0) {
        return browserslist();
    }

    return browserslist(config.browserslist);
};

/** Loads a configuration file from the given file path. */
export const loadUserConfig = (filePath: string): UserConfig => {

    const resolvedPath: string = path.resolve(process.cwd(), filePath);
    const config: UserConfig = loadConfigFile(resolvedPath);

    if (!config || !validateConfig(config)) {
        throw new Error(`Couldn't find any valid configuration`);
    }

    return config;
};

/**
 * Retrieves the configuration filename for a given directory. It loops over all
 * of the valid configuration filenames in order to find the first one that exists.
 */
export const getFilenameForDirectory = (directory: string): string | null => {

    for (let i = 0, len = CONFIG_FILES.length; i < len; i++) {
        const filename: string = path.join(directory, CONFIG_FILES[i]);

        if (shell.test('-f', filename)) {
            return filename;
        }
    }

    return null;
};

// ------------------------------------------------------------------------

/**
 * Calculates the final configuration taking into account any `extends` fields.
 * Configurations for `extends` are applied left to right.
 *
 */
const composeConfig = (userConfig: UserConfig) => {
    /*
     * If an `extends` property is defined, it represents a configuration package to use as
     * a "parent". Load the configuration and merge recursively.
     */

    debug('Composing configuration from extends');

    if (!userConfig.extends || !Array.isArray(userConfig.extends) || userConfig.extends.length === 0) {
        return userConfig;
    }

    const configurations = userConfig.extends.map((config) => {
        const loadedConfiguration = resourceLoader.loadConfiguration(config);

        if (!validateConfig(loadedConfiguration)) {
            throw new Error(`Configuration package "${config}" is not valid`);
        }

        return composeConfig(loadedConfiguration);
    });

    const finalConfig = _.merge({}, ...configurations, userConfig);

    return finalConfig;
};

const loadIgnoredUrls = (userConfig: UserConfig): Map<string, RegExp[]> => {
    debug('Initializing ignored urls');

    const ignoredUrls: Map<string, RegExp[]> = new Map();

    if (userConfig.ignoredUrls) {
        userConfig.ignoredUrls.forEach((ignoredUrl: IgnoredUrl) => {
            const { domain: urlRegexString, rules } = ignoredUrl;

            rules.forEach((rule: string) => {
                const ruleName = rule === '*' ? 'all' : rule;

                const urlsInRule: Array<RegExp> = ignoredUrls.get(ruleName);
                const urlRegex: RegExp = new RegExp(urlRegexString, 'i');

                if (!urlsInRule) {
                    ignoredUrls.set(ruleName, [urlRegex]);
                } else {
                    urlsInRule.push(urlRegex);
                }
            });
        });
    }

    return ignoredUrls;
};

export class SonarwhalConfig {
    public readonly browserslist;
    public readonly connector;
    public readonly formatters: Array<string>;
    public readonly ignoredUrls;
    public readonly parsers: Array<string>;
    public readonly rules;
    public readonly rulesTimeout: number;

    private constructor(userConfig: UserConfig, browsers, ignoredUrls) {
        this.browserslist = browsers;
        this.connector = userConfig.connector;
        this.formatters = userConfig.formatters;
        this.ignoredUrls = ignoredUrls;
        this.parsers = userConfig.parsers;
        this.rules = userConfig.rules;
        this.rulesTimeout = userConfig.rulesTimeout || 60000;
    }

    /**
     * Loads a configuration file regardless of the source. Inspects the file path
     * to determine the correctly way to load the config file.
     */
    public static create(filePath: string) {
        /**
         * 1. Load the file from the HD
         * 2. Validate it's OK
         * 3. Read extends and validate they are OK
         * 4. Apply extends
         * 6. Return final configuration object with defaults if needed
         */

        // 1
        const resolvedPath: string = path.resolve(process.cwd(), filePath);
        let userConfig = loadConfigFile(resolvedPath);

        // 2
        if (!userConfig) {
            throw new Error(`Couldn't find a configuration file`);
        }

        if (!validateConfig(userConfig)) {
            throw new Error(`Couldn't find any valid configuration`);
        }

        // 3, 4
        userConfig = composeConfig(userConfig);

        debug('Setting the selected formatters');

        if (!Array.isArray(userConfig.formatters)) {
            userConfig.formatters = [userConfig.formatters];
        }

        const browsers = loadBrowsersList(userConfig);
        const ignoredUrls = loadIgnoredUrls(userConfig);

        return new SonarwhalConfig(userConfig, browsers, ignoredUrls);
    }
}
