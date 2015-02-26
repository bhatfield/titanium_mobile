/**
 * Copyright (c) 2015 Appcelerator, Inc. All Rights Reserved.
 * Licensed under the terms of the Apache Public License.
 * 
 * Script to preprocess the YAML docs in to a common JSON format,
 * then calls an generator script to format the API documentation.
 */

var common = require('./lib/common.js'),
	colors = require('colors'),
	nodeappc = require('node-appc'),
	ejs = require('ejs'),
	fs = require('fs'),
	exec = require('child_process').exec,
	os = require('os'),
	assert = common.assertObjectKey;
	basePaths = [],
	processFirst = ['Titanium.Proxy', 'Titanium.Module', 'Titanium.UI.View'],
	skipList = ['Titanium.Namespace.Name'],
	validFormats = [],
	apidocPath = '.',
	libPath = './lib/',
	templatePath = './templates/',
	formats = ['html'],
	outputPath = output = '../dist/',
	parseData = {},
	doc = {},
	errors = [],
	exportData = {},
	exporter = null,
	processedData = {},
	render = '',
	fsArray = [],
	tokens = [],
	excludeExternal = false;
	originalPaths = [],
	modules = [],
	exportStdout = false,
	cssPath = '',
	cssFile = '',
	addOnDocs = [],
	searchPlatform = '';

/**
 * Returns a list of inherited APIs.
 * @params api {Object} API object to extract inherited APIs
 * @returns {Object} Object containing all API members for the class
 */
function getInheritedAPIs (api) {

	var inheritedAPIs = { 'events': [], 'methods': [], 'properties': [] },
		key = null,
		removeAPIs = [],
		copyAPIs = [],
		matches = [],
		index = 0,
		x = 0;

	if (assert(api, 'extends') && api.extends in doc) {
		inheritedAPIs = getInheritedAPIs(doc[api.extends]);

		// Remove inherited accessors
		matches = inheritedAPIs.methods.filter(function (element) {
			return assert(element, '__accessor');
		});
		matches.forEach(function (element) {
			inheritedAPIs.methods.splice(inheritedAPIs.methods.indexOf(element), 1);

		});

		for (key in inheritedAPIs) {
			removeAPIs = [];
			if (!key in api || !api[key]) continue;
			copyAPIs = nodeappc.util.mixObj([], api[key]);
			inheritedAPIs[key].forEach(function (inheritedAPI) {

				// See if current API overwrites inherited API
				matches = copyAPIs.filter(function (element) {
					return (element.name == inheritedAPI.name);
				});

				matches.forEach(function (match) {
					removeAPIs.push(match);
					// If the APIs came from the same class, do nothing
					if (match.__inherits == inheritedAPI.__inherits) return;

					// If the APIs are from different classes, override inherited API with current API
					index = inheritedAPIs[key].indexOf(inheritedAPI);
					for (property in match) {
						if (assert(match, property)) {
							inheritedAPIs[key][index][property] = match[property];
						}
					}
					inheritedAPIs[key][index].__inherits = api.name;
				});
			});

			removeAPIs.forEach(function (element) {
				copyAPIs.splice(copyAPIs.indexOf(element), 1);
			});
			for (x = 0; x < copyAPIs.length; x++) {
				copyAPIs[x].__inherits = api.name;
			}
			inheritedAPIs[key] = inheritedAPIs[key].concat(copyAPIs);
		}

	} else {
		for (key in inheritedAPIs) {
			if (!key in api || !api[key]) continue;
			inheritedAPIs[key] = nodeappc.util.mixObj([], api[key]);
			for (x = 0; x < inheritedAPIs[key].length; x++) {
				inheritedAPIs[key][x].__inherits = api.name;
			}
		}
	}
	return inheritedAPIs;
}

/**
 * Returns a list of constants
 * @params api {Object} API to evaluate
 * @returns {Array<String>} List of constants the API supports
 */
function processConstants (api) {
	var rv = [];
	if ('constants' in api) {
		if (!Array.isArray(api.constants)) api.constants = [api.constants];
		api.constants.forEach(function (constant) {
			if (constant.charAt(constant.length - 1) == '*') {
				var prop = constant.split('.').pop(),
					prop = prop.substring(0, prop.length - 1),
					cls = constant.substring(0, constant.lastIndexOf('.'));
				if (cls in doc && 'properties' in doc[cls]) {
					doc[cls].properties.forEach(function (property) {
						if (property.name.indexOf(prop) == 0 && property.name.match(common.REGEXP_CONSTANTS)) rv.push(cls + '.' + property.name);
					});
				}
			} else {
				rv.push(constant);
			}
		});
	}
	return rv;
}

/**
 * Returns a list of platforms and since versions the API supports
 * @params api {Object} API to evaluate
 * @params versions {Object} Possible platforms and versions the API supports (usually from the class)
 * @params matchVersion {Boolean} For members, only match platforms from the versions param
 * @returns {Object} Object containing platforms and versions the API supports
 */
function processVersions (api, versions, matchVersion) {
	var defaultVersions = nodeappc.util.mixObj({}, versions),
		platform = null,
		key = null;
	if (assert(api, 'platforms')) {
		for (platform in defaultVersions) {
			if (!~api.platforms.indexOf(platform)) delete defaultVersions[platform];
		}
		for (platform in common.ADDON_VERSIONS) {
			if (((matchVersion && ~Object.keys(versions).indexOf(platform)) || !matchVersion)
				&& ~api.platforms.indexOf(platform)) {
					defaultVersions[platform] = common.ADDON_VERSIONS[platform];
			}
		}
	} else if (assert(api, 'exclude-platforms')) {
		api['exclude-platforms'].forEach(function (platform) {
			if (platform in defaultVersions) delete defaultVersions[platform];
		});
		// Remove add-on platforms from defaults if exclude-platforms tag is used
		Object.keys(common.ADDON_VERSIONS).forEach(function (platform) {
			if (platform in defaultVersions) delete defaultVersions[platform];
		});
	} else {
		// Remove add-on platforms from defaults if platforms tag is not specified
		Object.keys(common.ADDON_VERSIONS).forEach(function (platform) {
			if (platform in defaultVersions) delete defaultVersions[platform];
		});
	}
	if (assert(api, 'since')) {
		if (typeof api.since == 'string') {
			for (key in defaultVersions) {
				if (nodeappc.version.gt(api.since, defaultVersions[key])) defaultVersions[key] = api.since;
			}
		} else {
			for (key in defaultVersions) {
				if (nodeappc.version.gt(api.since[key], defaultVersions[key])) defaultVersions[key] = api.since[key];
			}
		}
	}
	return defaultVersions;
}

/**
 * Processes APIs based on the given list of platforms and versions
 * @params apis {Array<Object>} List of APIs to evaluate
 * @param type {String} Type of API
 * @params defaultVersions {Object} List of platforms and versions the APIs support
 * @returns {Array<Object>} List of processed APIs
 */
function processAPIMembers (apis, type, defaultVersions) {
	var rv = [], x = 0;
	apis.forEach(function (api) {
		api.since = processVersions(api, defaultVersions, true);
		api.platforms = Object.keys(api.since);
		if (type == 'properties') {
			if (api.constants) {
				api.constants = processConstants(api);
			}
			api.__subtype = 'property';
		}
		if (type == 'events') {
			api.__subtype = 'event';
			if (assert(api, 'properties')) {
				for (x = 0; x < api.properties.length; x++) {
					api.properties[x].__subtype = 'eventProperty';
					if ('constants' in api.properties[x]) {
						api.properties[x].constants = processConstants(api.properties[x]);
					}
				}
			}
		}
		if (type == 'methods') {
			api.__subtype = 'method';
			if (assert(api, 'parameters')) {
				for (x = 0; x < api.parameters.length; x++) {
					api.parameters[x].__subtype = 'parameter';
					if ('constants' in api.parameters[x]) {
						api.parameters[x].constants = processConstants(api.parameters[x]);
					}
				}
			}
			if (assert(api, 'returns')) {
				if (Array.isArray(api.returns)) api.returns = [api.returns];
				for (x = 0; x < api.returns.length; x++) {
					api.returns[x].__subtype = 'return';
					if (assert(api.returns[x], 'constants')) {
						api.returns[x].constants = processConstants(api.returns[x]);
					}
				}
			}
		}
		if (api.platforms.length > 0) rv.push(api);
	});
	return rv;
}

/**
 * Hides APIs based on the excludes list
 * @params apis {Object} APIs to evaluate
 * @params type {String} Type of API, one of 'events', 'methods' or 'properties'
 * @returns {Array<Object>} Processed APIs
 */
function hideAPIMembers (apis, type) {
	if (assert(apis, 'excludes') && assert(apis.excludes, type) && assert(apis, type)) {
		apis[type].forEach(function (api) {
			apis[type][apis[type].indexOf(api)].__hide = (~apis.excludes[type].indexOf(api.name)) ? true : false;
		});
	}
	return apis;
}

/**
 * Generates accessors from the given list of properties
 * @param apis {Array<Object>} Array of property objects
 * @param className {String} Name of the class
 * @returns {Array<Object>} Array of methods
 */
function generateAccessors(apis, className) {
	var rv = [];
	apis.forEach(function (api) {

		if ('accessors' in api && api.accessors === false) return;

		// Generate getter
		if (!('permission' in api && api.permission == 'write-only') && !api.name.match(common.REGEXP_CONSTANTS)) {
			rv.push({
				'name': 'get' + api.name.charAt(0).toUpperCase() + api.name.slice(1),
				'summary': 'Gets the value of the <' + className + '.' + api.name + '> property.',
				'deprecated' : api.deprecated || null,
				'platforms': api.platforms,
				'since': api.since,
				'returns': { 'type': api.type, '__subtype': 'return' },
				'__accessor': true,
				'__hides' : api.__hides || false,
				'__inherits': api.__inherits || null,
				'__subtype': 'method'
			});
		}

		// Generate setter
		if (!('permission' in api && api.permission == 'read-only')) {
			rv.push({
				'name': 'set' + api.name.charAt(0).toUpperCase() + api.name.slice(1),
				'summary': 'Sets the value of the <' + className + '.' + api.name + '> property.',
				'deprecated' : api.deprecated || null,
				'platforms': api.platforms,
				'since': api.since,
				'parameters': [{
					'name': api.name,
					'summary': 'New value for the property.',
					'type': api.type,
					'__subtype': 'parameter'
				}],
				'__accessor': true,
				'__hides' : api.__hides || false,
				'__inherits': api.__inherits || null,
				'__subtype': 'method'
			});
		}
	});
	return rv;
}

/**
 * Returns a subtype based on the parent class
 * @param api {Object} Class object
 * @returns {String} Class's subtype
 */
function getSubtype (api) {
	switch (api.name) {
		case 'Global':
		case 'Titanium.Module':
			return 'module';
			break;
		case 'Titanium.Proxy':
			return 'proxy';
			break;
		default:
			;
	}

	if (api.name.indexOf('Global.') == 0) {
		return 'proxy';
	}

	switch (api.extends) {
		case 'Titanium.UI.View' :
			return 'view';
		case 'Titanium.Module' :
			return 'module';
		case 'Titanium.Proxy' :
			return 'proxy';
		default:
			if (assert(api, 'extends') && assert(doc, api.extends)) {
				return getSubtype(doc[api.extends]);
			} else {
				return 'pseudo';
			}
	}
}

function processAPIs (api) {
	var defaultVersions = nodeappc.util.mix({}, common.DEFAULT_VERSIONS),
		inheritedAPIs = {};

	// Generate list of supported platforms and versions
	api.since = processVersions(api, defaultVersions, false);
	api.platforms = Object.keys(api.since);

	// Get inherited APIs
	inheritedAPIs = getInheritedAPIs(api);
	for (var key in inheritedAPIs) {
		api[key] = inheritedAPIs[key];
	}

	api.__subtype = getSubtype(api);

	// Generate create method
	api.__creatable = false;
	if ((api.__subtype === 'view' || api.__subtype === 'proxy') &&
		(assert(api, 'createable') || !('createable' in api))) {

		var name = api.name,
			prop = name.split('.').pop(),
			cls = name.substring(0, name.lastIndexOf('.')),
			methodName = 'create' + prop;

		if (cls in doc) {
			var matches = [];
			if (assert(doc[cls], 'methods')) {
				var matches = doc[cls].methods.filter(function (member) {
					return member.name == methodName;
				});
			}
			if (matches.length == 0) {
				var createMethod = {
					'name': methodName,
					'summary': 'Creates and returns an instance of <' + name + '>.\n',
					'deprecated': api.deprecated || null,
					'since': api.since,
					'platforms': api.platforms,
					'returns': { 'type': name, '__subtype': 'return' },
					'parameters': [{
						'name': 'parameters',
						'summary': 'Properties to set on a new object, including any defined by <' + name + '> except those marked not-creation or read-only.\n',
						'type': 'Dictionary<' + name + '>',
						'optional': true,
						'__subtype': 'parameter'
					}],
					'__creator': true,
					'__subtype': 'method'
				};
				api.__creatable = true;
				'methods' in doc[cls] ? doc[cls].methods.push(createMethod) : doc[cls].methods = [createMethod];
			}
		}
	}

	if (assert(api, 'events')) {
		api = hideAPIMembers(api, 'events');
		api.events = processAPIMembers(api.events, 'events', api.since);
	}

	if (assert(api, 'properties')) {
		var accessors;
		api = hideAPIMembers(api, 'properties');
		api.properties = processAPIMembers(api.properties, 'properties', api.since);
		if (api.__subtype != 'pseudo' && (accessors = generateAccessors(api.properties, api.name))) {
			if (assert(api, 'methods')) {
				var matches = [];
				accessors.forEach(function (accessor) {
					matches = api.methods.filter(function (element) {
						return accessor.name == element.name;
					});
				});
				matches.forEach(function (element) {
					accessors.splice(accessors.indexOf(element), 1);
				});
				api.methods = api.methods.concat(accessors);
			} else {
				api.methods = accessors;
			}
		}
	}

	if (assert(api, 'methods')) {
		api = hideAPIMembers(api, 'methods');
		api.methods = processAPIMembers(api.methods, 'methods', api.since);
	}

	return api;
}

function cliUsage () {
	common.log('Usage: node docgen.js [--addon-docs <PATH_TO_YAML_FILES] [--css <CSS_FILE>] [--format <EXPORT_FORMAT>] [--output <OUTPUT_DIRECTORY>] [--stdout] [<PATH_TO_YAML_FILES>]');
	common.log('\nOptions:');
	common.log('\t--addon-docs, -a\tDocs to add to the base Titanium Docs');
	common.log('\t--css           \tCSS style file to use for HTML exports.');
	common.log('\t--format, -f    \tExport format: %s. Default is html.', validFormats);
	common.log('\t--output, -o    \tDirectory to output the files.');
	common.log('\t--stdout        \tOutput processed YAML to stdout.');
}

// Merge values from add-on object to base object
function addOnMerge(baseObj, addObj) {
	var key = base = add = null,
		rv = baseObj;

	for (key in addObj) {
		var base = baseObj[key];
		var add = addObj[key];
		if (Array.isArray(base)) {
			// Array of objects
			if (typeof base[0] === 'object') {

				var tempArray = base;
				add.forEach(function (api) {
					if ('name' in base[0]) {
						var match = base.filter(function (item) {
							return api.name == item.name;
						});
						if (match.length > 0) {
							// Replace item if we have a match
							tempArray.splice(tempArray.indexOf(match[0]), 1);
							tempArray.push(addOnMerge(match[0], api));
						} else {
							common.log(common.LOG_WARN, 'Could not locate object in %s array with name: %s', key, api.name);
						}
					} else {
						common.log(common.LOG_WARN, 'Element in %s array do not have a name key.', key);
					}
				});
				baseObj[key] = tempArray;
			// Array of primitives
			} else {
				if (Array.isArray(add)) {
					baseObj[key] = base.concat(add);
				} else {
					baseObj[key] = base.push(add);
				}
			}
		} else {
			switch (typeof base) {
				case 'object':
					baseObj[key] = addOnMerge(base, add);
					break;
				case 'string':
					if (!~['name', 'since', '__file'].indexOf(key)) {
						baseObj[key] += ' ' + add;
					}
					else if (key === 'since') {
						var platforms = baseObj.platforms || common.VALID_PLATFORMS,
							since = {};

						platforms.forEach(function(p){
							since[p] = baseObj[key];
						});

						if (typeof add === 'object') {
							Object.keys(add).forEach(function (k) {
								since[k] = add[k];
							});
						}
						else if (assert(addObj, 'platforms')) {
							addObj.platforms.forEach(function (p) {
								since[p] = add;
							});
						}
						else {
							common.log(common.LOG_WARN, 'Cannot set since version.  Set since as a dictionary or add the platforms property.');
							break;
						}

						baseObj[key] = since;
					}
					break;
				case 'undefined':
					if (~['description'].indexOf(key)) {
						baseObj[key] = add;
					}
					else if (key == 'exclude-platforms' && !assert(baseObj, 'platforms')) {
						baseObj[key] = add;
					}
					else if (key == 'platforms') {
						baseObj[key] = common.VALID_PLATFORMS.concat(add);
					}
					else if (key == 'since') {
						var since = {};
						if (typeof add === 'object') {
							Object.keys(add).forEach(function (k) {
								since[k] = add[k];
							});
						}
						else if (assert(addObj, 'platforms')) {
							addObj.platforms.forEach(function (p) {
								since[p] = add;
							});
						}
						else {
							common.log(common.LOG_WARN, 'Cannot set since version.  Set since as a dictionary or add the platforms property.');
						}
						baseObj[key] = since;
					}
					else {
						common.log(common.LOG_WARN, 'Base object does not have a value for %s', key);
					}
					break;
				default:
					common.log(common.LOG_WARN, 'Could not merge %s key: %s to %s', key, base, add);
			}
		}
	}
	return rv;
}


// Create path if it does not exist
function mkdirDashP(path) {
	var p = path.replace(/\\/g, '/');
	p = p.substring(0, path.lastIndexOf('/'));
	if(!fs.existsSync(p)) {
		mkdirDashP(p);
	}
	if(!fs.existsSync(path)) {
		fs.mkdirSync(path);
	}
}

// Start of Main Flow
// Get a list of valid formats
apidocPath = process.argv[1].replace(/\\/g, '/');
apidocPath = apidocPath.substring(0, apidocPath.lastIndexOf('/'));
libPath = apidocPath + '/lib/';
fsArray = fs.readdirSync(libPath);
fsArray.forEach(function (file) {
	tokens = file.split('_');
	if (tokens[1] == 'generator.js') validFormats.push(tokens[0]);
});

// Check command arguments
if ((argc = process.argv.length) > 2) {
	for (var x = 2; x < argc; x++) {
		switch (process.argv[x]) {
			case '--help' :
				cliUsage();
				process.exit(0);
				break;
			case '--addon-docs' :
			case '-a':
				path = process.argv[++x];
				if (fs.existsSync(path)) {
					addOnDocs.push(path);
				} else {
					common.log(common.LOG_WARN, "Path does not exist: %s", path);
				}
				path = null;
				break;
			case '--css':
				if (++x > argc) {
					common.log(common.LOG_WARN, 'Did not specify a CSS file.');
					cliUsage();
					process.exit(1);
				}
				cssPath = process.argv[x];
				if(!fs.existsSync(cssPath)) {
					common.log(common.LOG_WARN, 'CSS file does not exist: %s', cssPath);
					process.exit(1);
				}
				cssFile = cssPath.substring(cssPath.lastIndexOf('/') + 1);
				break;
			case '--format' :
			case '-f' :
				if (++x > argc) {
					common.log(common.LOG_WARN, 'Did not specify an export format. Valid formats are: %s', JSON.stringify(validFormats));
					cliUsage();
					process.exit(1);
				}

				if(~process.argv[x].indexOf(',')) {
					formats = process.argv[x].split(',');
				} else {
					formats = [process.argv[x]];
				}

				formats.forEach(function (format) {
					if (!~validFormats.indexOf(format)) {
						common.log(common.LOG_WARN, 'Not a valid export format: %s. Valid formats are: %s', format, validFormats);
						cliUsage();
						process.exit(1);
					}
				});
				break;
			case '--output' :
			case '-o' :
				if (++x > argc) {
					common.log(common.LOG_WARN, 'Specify an output path.');
					cliUsage();
					process.exit(1);
				}
				outputPath = process.argv[x];
				break;
			case '--platform':
			case '-p':
				if (++x > argc) {
					common.log(common.LOG_WARN, 'Specify a platform.');
					cliUsage();
					process.exit(1);
				}
				searchPlatform = process.argv[x];
				if (!~common.VALID_PLATFORMS.indexOf(searchPlatform)) {
					common.log(common.LOG_WARN, 'Not a valid platform. Specify one of the following: %s', common.VALID_PLATFORMS);
					process.exit(1);
				}
				break;
				exportStdout = true;
				break;
			case '--colorize':
			case '--exclude-external':
			case '-e':
			case '--stdout':
			case '--verbose':
			case '--version':
			case '-v' :
			case '--warn-inherited':
				common.log(common.LOG_WARN, 'This command-line flag or argument has been deprecated or has not been implemented: %s', process.argv[x]);
				if (~['-v', '--version'].indexOf(process.argv[x])) x++;
				break;
			default:
				path = process.argv[x];
				if (fs.existsSync(path)) {
					basePaths.push(path);
				} else {
					common.log(common.LOG_WARN, "Path does not exist: %s", path);
				}
				path = null;
		}
	}
}

// Parse YAML files
originalPaths = originalPaths.concat(basePaths);
basePaths.push(apidocPath);
basePaths.forEach(function (basePath) {
	var key;
	common.log(common.LOG_INFO, 'Parsing YAML files in %s...', basePath);
	parseData = common.parseYAML(basePath);
	for (key in parseData.data) {
		errors.push(parseData.errors);
		if (assert(doc, key)) {
			common.log(common.LOG_WARN, 'Duplicate class found: %s', key);
			continue;
		}
		doc[key] = parseData.data[key];
		if (~originalPaths.indexOf(basePath)) modules.push(key);
	}
});

// Parse add-on docs and merge them with the base set
addOnDocs.forEach(function (basePath) {
	var key;
	parseData = null;
	common.log(common.LOG_INFO, 'Parsing YAML files in %s...', basePath);
	parseData = common.parseYAML(basePath);
	for (key in parseData.data) {
		errors.push(parseData.errors);
		if (assert(doc, key)) {
			common.log(common.LOG_INFO, 'Adding on to %s...', key);
			doc[key] = addOnMerge(doc[key], parseData.data[key]);
		} else {
			common.log(common.LOG_INFO, 'New class found in add-on docs: %s...', key);
			doc[key] = parseData.data[key];
		}
	}
});

// Process YAML files
common.log(common.LOG_INFO, 'Processing YAML data...');
processFirst.forEach(function (cls) {
	if (!assert(doc, cls)) return;
	processedData[cls] = processAPIs(doc[cls]);
});
skipList = skipList.concat(processFirst);
for (key in doc) {
	if (~skipList.indexOf(key)) continue;
	processedData[key] = processAPIs(doc[key]);
}

formats.forEach(function (format) {
	// Export data
	exporter = require('./lib/' + format + '_generator.js');
	if (format == 'modulehtml') {
		processedData.__modules = modules;
	}
	if (searchPlatform) {
		processedData.__platform = searchPlatform;
	}
	exportData = exporter.exportData(processedData);
	templatePath = apidocPath + '/templates/';
	output = outputPath;
	mkdirDashP(output);

	common.log(common.LOG_INFO, 'Generating %s output...', format.toUpperCase());

	switch (format) {
		case 'addon':
			if (searchPlatform == null) {
				common.log(common.LOG_ERROR, 'Specify a platform to extract with the -p option.');
				break;
			}

			output += 'addon/';
			if(!fs.existsSync(output)) {
				fs.mkdirSync(output);
			}
			templateStr = fs.readFileSync(templatePath + 'addon.ejs', 'utf8');
			for (cls in exportData) {
				if (cls.indexOf('__') == 0) continue;
				render = ejs.render(templateStr, {doc: exportData[cls]});
				if (fs.writeFileSync(output + cls + '.yml', render) <= 0) {
					common.log(common.LOG_ERROR, 'Failed to write to file: %s', output + member.filename + '.html');
				}
			}
			exportData.__copyList.forEach(function(file) {
				copyCommand = 'cp ' + file + ' ' + output;
				exec(copyCommand, function (error) {
					if (error !== null) {
						common.log(common.LOG_ERROR, 'Error copying file: %s', error);
					}
				});
			});
		    common.log("Generated output at %s".green, output);
		    break;
		case 'html' :
		case 'modulehtml' :

			var copyCommand;

			output += '/apidoc/';
			if(!fs.existsSync(output)) {
				fs.mkdirSync(output);
			}

			if (cssFile) {
				fs.createReadStream(cssPath).pipe(fs.createWriteStream(output + cssFile));
			}

			if (os.type() == 'Windows_NT') {
				copyCommand = 'xcopy ' + apidocPath + '/images' + ' ' + output;
				copyCommand = copyCommand.replace(/\//g, '\\') + ' /s';
			} else {
				copyCommand = 'cp -r ' + apidocPath + '/images' + ' ' + output;
			}

			exec(copyCommand, function (error) {
				if (error !== null) {
					common.log(common.LOG_ERROR, 'Error copying file: %s', error);
				}
			});

			for (type in exportData) {
				if (type.indexOf('__') == 0) continue;
				templateStr = fs.readFileSync(templatePath + 'htmlejs/' + type + '.html', 'utf8');
				exportData[type].forEach(function (member) {
					render = ejs.render(templateStr, {data: member, filename: true, assert: common.assertObjectKey, css: cssFile});
					if (fs.writeFileSync(output + member.filename + '.html', render) <= 0) {
						common.log(common.LOG_ERROR, 'Failed to write to file: %s', output + member.filename + '.html');
					}
				});
			}

			if (format === 'modulehtml') {
				templateStr = fs.readFileSync(templatePath + 'htmlejs/moduleindex.html', 'utf8');
				render = ejs.render(templateStr, {filename: exportData.proxy[0].filename + '.html'});
			} else {
				templateStr = fs.readFileSync(templatePath + 'htmlejs/index.html', 'utf8');
				render = ejs.render(templateStr, {data: exportData, assert: common.assertObjectKey, css: cssFile});
			}
			output += 'index.html';
			break;
		case 'jsca' :
			render = JSON.stringify(exportData, null, '    ');
			output = output + 'api.jsca';
			break;
		case 'json' :
			render = JSON.stringify(exportData, null, '    ');
			output = output + 'api.json';
			break;
		case 'jsduck' :
			templateStr = fs.readFileSync(templatePath + 'jsduck.ejs', 'utf8');
			render = ejs.render(templateStr, {doc: exportData});
			output = output + 'titanium.js';
			break;
		case 'parity' :
			templateStr = fs.readFileSync(templatePath + 'parity.ejs', 'utf8');
			render = ejs.render(templateStr, {apis: exportData});
			output = output + 'parity.html';
			break;
		default:
			;
	}

	if (!~['addon'].indexOf(format)) {
		if (fs.writeFile(output, render) <= 0) {
			common.log(common.LOG_ERROR, 'Failed to write to file: %s', output);
			process.exit(1);
		} else {
		    common.log("Generated output at %s", output);
		}
	}
	exporter = exportData = null;

});
