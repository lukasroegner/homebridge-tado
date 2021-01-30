
/**
 * Represents a heating zone in Tado.
 * @param platform The TadoPlatform instance.
 * @param apiZone The zone from the API.
 */
function TadoHeatingZone(platform, apiZone) {
    const zone = this;
    const { UUIDGen, Accessory, Characteristic, Service } = platform;

    // Sets the ID and platform
    zone.id = apiZone.id;
    zone.platform = platform;

    // Gets all accessories from the platform that match the zone ID
    let unusedZoneAccessories = platform.accessories.filter(function(a) { return a.context.id === zone.id; });
    let newZoneAccessories = [];
    let zoneAccessories = [];

    // Gets the thermostat accessory
    let thermostatAccessory = unusedZoneAccessories.find(function(a) { return a.context.kind === 'ThermostatAccessory'; });
    if (thermostatAccessory) {
        unusedZoneAccessories.splice(unusedZoneAccessories.indexOf(thermostatAccessory), 1);
    } else {
        platform.log('Adding new accessory with zone ID ' + zone.id + ' and kind ThermostatAccessory.');
        thermostatAccessory = new Accessory(apiZone.name, UUIDGen.generate(zone.id + 'ThermostatAccessory'));
        thermostatAccessory.context.id = zone.id;
        thermostatAccessory.context.kind = 'ThermostatAccessory';
        newZoneAccessories.push(thermostatAccessory);
    }
    zoneAccessories.push(thermostatAccessory);

    // Registers the newly created accessories
    platform.api.registerPlatformAccessories(platform.pluginName, platform.platformName, newZoneAccessories);

    // Removes all unused accessories
    for (let i = 0; i < unusedZoneAccessories.length; i++) {
        const unusedZoneAccessory = unusedZoneAccessories[i];
        platform.log('Removing unused accessory with zone ID ' + unusedZoneAccessory.context.id + ' and kind ' + unusedZoneAccessory.context.kind + '.');
        platform.accessories.splice(platform.accessories.indexOf(unusedZoneAccessory), 1);
    }
    platform.api.unregisterPlatformAccessories(platform.pluginName, platform.platformName, unusedZoneAccessories);

    // Gets the zone leader
    const zoneLeader = apiZone.devices.find(function(d) { return d.duties.some(function(duty) { return duty === 'ZONE_LEADER'; }); });
    if (!zoneLeader) {
        zoneLeader = apiZone.devices[0];
    }

    // Updates the accessory information
    for (let i = 0; i < zoneAccessories.length; i++) {
        const zoneAccessory = zoneAccessories[i];
        let accessoryInformationService = zoneAccessory.getService(Service.AccessoryInformation);
        if (!accessoryInformationService) {
            accessoryInformationService = zoneAccessory.addService(Service.AccessoryInformation);
        }
        accessoryInformationService
            .setCharacteristic(Characteristic.Manufacturer, 'Tado')
            .setCharacteristic(Characteristic.Model, zoneLeader.deviceType)
            .setCharacteristic(Characteristic.SerialNumber, zoneLeader.serialNo)
            .setCharacteristic(Characteristic.FirmwareRevision, zoneLeader.currentFwVersion);
    }

    // Add, remove and update switches for each sensor in a zone
    zone.sensors = []

    for (let i = 0; i < platform.config.zones.length; i++) {
        if (platform.config.zones[i].zoneId == zone.id) {

            let currentSensors = [];
            let newSensors = [];
        
            // Load all defined switches and store them temporarily to allow removal of switches
            for (let i = 0; i < 10; i++) {
                let subtype = 'sensor-' + i;
                let switchService = thermostatAccessory.getServiceByUUIDAndSubType(Service.Switch, subtype);
        
                if (switchService) {
                    currentSensors.push(switchService);
                }
            }

            platform.log(zone.id + ' - Found sensor switches: ' + currentSensors.length);

            // Apply the coonfig and try to match it against the exisiting switches
            for (let s = 0; s < platform.config.zones[i].sensors.length; s++) {
                let sensorConfig = platform.config.zones[i].sensors[s];

                let subtype = 'sensor-' + s;
                let sensorName = sensorConfig.name || 'Switch #' + (1 + s);

                // Do we already have a switch for this? If so, remove it from the list and use it for processing
                let sensorSwitch = currentSensors.find( item => (item.name == sensorName));
                if (!sensorSwitch) {
                    sensorSwitch = currentSensors.find( item => (item.subtype == subtype));
                } 
                currentSensors = currentSensors.filter( item => (item !== sensorSwitch));

                if (!sensorSwitch) {
                    platform.log(zone.id + ' - New sensor switch for ' + sensorName);

                    sensorSwitch = new Service.Switch(sensorName, subtype);
                    newSensors.push(sensorSwitch);
                }            
                else {
                    platform.log(zone.id + ' - Sensor switch ' + sensorSwitch.subtype + ' already exists, updating.');
                }

                sensorSwitch.name = sensorName;
                sensorSwitch.subtype = subtype;
                sensorSwitch.isHiddenService = true;

                sensorSwitch
                    .updateCharacteristic(Characteristic.Name, sensorName); 

                sensorSwitch
                    .getCharacteristic(Characteristic.On)
                    .on('set', zone.checkSensorState.bind(this, sensorSwitch));

                zone.sensors.push(sensorSwitch);
            }

            platform.log(zone.id + ' - Removing outdated sensors ' + currentSensors.length);
            currentSensors.forEach( sensor => thermostatAccessory.removeService(sensor));

            platform.log(zone.id + ' - Adding new sensors ' + newSensors.length);
            newSensors.forEach( sensor => thermostatAccessory.addService(sensor));
        }
    }
    
    // Updates the thermostat service
    let thermostatService = thermostatAccessory.getServiceByUUIDAndSubType(Service.Thermostat);
    if (!thermostatService) {
        thermostatService = thermostatAccessory.addService(Service.Thermostat);
    }

    thermostatService.isPrimaryService = true;

    // Disables cooling
    thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).setProps({
        maxValue: 1,
        minValue: 0,
        validValues: [0, 1]
    });
    thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({
        maxValue: 3,
        minValue: 0,
        validValues: [0, 1, 3]
    });
    thermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({
        maxValue: 25,
        minValue: 5,
        minStep: 0.1
      });

    // Stores the thermostat service
    zone.thermostatService = thermostatService;

    // Updates the humidity sensor service
    let humiditySensorService = thermostatAccessory.getServiceByUUIDAndSubType(Service.HumiditySensor);
    if (!humiditySensorService) {
        humiditySensorService = thermostatAccessory.addService(Service.HumiditySensor);
    }

    // Stores the humidity sensor service
    zone.humiditySensorService = humiditySensorService;

    // Updates the contact snesor service
    let contactSensorService = thermostatAccessory.getServiceByUUIDAndSubType(Service.ContactSensor);
    if (apiZone.openWindowDetection && apiZone.openWindowDetection.supported && apiZone.openWindowDetection.enabled && !platform.config.areWindowSensorsHidden) {
        if (!contactSensorService) {
            contactSensorService = thermostatAccessory.addService(Service.ContactSensor);
        }
    } else {
        if (contactSensorService) {
            thermostatAccessory.removeService(contactSensorService);
            contactSensorService = null;
        }
    }

    // Stores the contact sensor service
    zone.contactSensorService = contactSensorService;

    // Sets termination variable from zone config
    let terminationOption;
    for (let i = 0; i < platform.config.zones.length; i++) {
        if (platform.config.zones[i].zoneId == zone.id) {
            terminationOption = platform.config.zones[i].terminationOption;
            break;
        }
    }
    let termination = 'manual';
    if (terminationOption == null && platform.config.switchToAutoInNextTimeBlock) {
        termination =  'auto';
    } else if (!isNaN(parseInt(terminationOption))) {
        termination = terminationOption * 60;
    } else {
        termination = terminationOption;
    }

    // Defines the timeout handle for fixing a bug in the Home app: whenever the target state is set to AUTO, the target temperature is also set
    // This is prevented by delaying changes of the TargetTemperature. If the TargetHeatingCoolingState characteristic is changed milliseconds after the TargetTemperature,
    // it is detected and changing of the TargetTemperature won't be executed
    let timeoutHandle = null;

    // Subscribes for changes of the target state characteristic
    thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).on('set', function (value, callback) {

        // Sets the state to OFF
        if (!value) {
            platform.log.debug(zone.id + ' - Switch target state to OFF');
            zone.platform.client.setZoneOverlay(platform.home.id, zone.id, 'off', thermostatService.getCharacteristic(Characteristic.TargetTemperature).value, termination).then(function() {

                // Updates the state
                zone.updateState();
            }, function(e) {
                platform.log(zone.id + ' - Failed to switch target state to OFF');
                platform.log.debug(e);
            });
        }

        // Sets the state to HEATING
        if (value === 1) {
            platform.log.debug(zone.id + ' - Switch target state to HEATING');
            zone.platform.client.setZoneOverlay(platform.home.id, zone.id, 'on', thermostatService.getCharacteristic(Characteristic.TargetTemperature).value, termination).then(function() {

                // Updates the state
                zone.updateState();
            }, function(e) {
                platform.log(zone.id + ' - Failed to switch target state to HEATING');
                platform.log.debug(e);
            });
        }

        // Sets the state to AUTO
        if (value === 3) {

            // Checks if a timeout has been set, which has to be cleared
            if (timeoutHandle) {
                platform.log.debug(zone.id + ' - Switch target state to AUTO: setting target temperature cancelled');
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }

            platform.log.debug(zone.id + ' - Switch target state to AUTO');
            zone.platform.client.clearZoneOverlay(platform.home.id, zone.id).then(function() {

                // Updates the state
                zone.updateState();
            }, function(e) {
                platform.log(zone.id + ' - Failed to switch target state to AUTO');
                platform.log.debug(e);
            });
        }

        // Performs the callback
        callback(null);
    });

    // Subscribes for changes of the target temperature characteristic
    thermostatService.getCharacteristic(Characteristic.TargetTemperature).on('set', function (value, callback) {
    
        // Sets the target temperature
        platform.log.debug(zone.id + ' - Set target temperature to ' + value + ' with delay');
        timeoutHandle = setTimeout(function () {
            platform.log.debug(zone.id + ' - Set target temperature to ' + value);
            zone.platform.client.setZoneOverlay(platform.home.id, zone.id, 'on', value, termination).then(function() {

                // Updates the state
                zone.updateState();
            }, function(e) {
                platform.log(zone.id + ' - Failed to set target temperature to ' + value);
                platform.log.debug(e);
            });
            timeoutHandle = null;
        }, 250);

        // Performs the callback
        callback(null);
    });
        
    // Sets the interval for the next update
    setInterval(function() { zone.updateState(); }, zone.platform.config.stateUpdateInterval * 1000);

    // Updates the state initially
    zone.updateState();
}

TadoHeatingZone.prototype.checkSensorState = function(switchService, value, callback) {
    const zone = this;
    const { Characteristic } = zone.platform;

    switchService.isOpen = value; 

    let openCount = 0;

    for (var index in zone.sensors) {
        var sensorSwitch = zone.sensors[index];

        if (sensorSwitch.isOpen) {
            openCount++;            
        }
    }

    zone.platform.log.debug(zone.id + ' - Open door or window detected? = ' + openCount);

    if (openCount == 0) {
        zone.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, '3');
    }
    else {
        zone.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, '0');
    }

    callback(null);
}

/**
 * Can be called to update the zone state.
 */
TadoHeatingZone.prototype.updateState = function () {
    const zone = this;
    const { Characteristic } = zone.platform;

    // Calls the API to update the state
    zone.platform.client.getZoneState(zone.platform.home.id, zone.id).then(function(state) {
        const apiZone = zone.platform.apiZones.find(function(z) { return z.id === zone.id; });
        apiZone.state = state;

        // Updates the current state
        zone.thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, state.setting.power === 'ON' && state.activityDataPoints.heatingPower && state.activityDataPoints.heatingPower.percentage > 0 ? 1 : 0);
        
        // Updates the target state
        if (zone.platform.config.isAlternativeStateLogicEnabled) {
            zone.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, state.setting.power === 'ON' ? (!state.overlayType ? 3 : 1) : 0);
        } else {
            zone.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, !state.overlayType ? 3 : (state.setting.power === 'ON' ? 1 : 0));
        }
        
        // Updates the temperatures
        zone.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, state.sensorDataPoints.insideTemperature.celsius);
        if (state.setting.temperature) {
            zone.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, state.setting.temperature.celsius);
        }

        // Updates the humidity
        zone.humiditySensorService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, state.sensorDataPoints.humidity.percentage);

        // Updates the contact sensor
        if (zone.contactSensorService) {
            zone.contactSensorService.updateCharacteristic(Characteristic.ContactSensorState, !!state.openWindow || !!state.openWindowDetected);
        }
        zone.platform.log.debug(zone.id + ' - Updated state.');
        zone.platform.log.debug(zone.id + ' - new state: ' + JSON.stringify(state));
    }, function() {
        zone.platform.log(zone.id + ' - Error getting state from API.');
    });
}

/**
 * Can be called to update the zone.
 */
TadoHeatingZone.prototype.updateZone = function (apiZones) {
    const zone = this;
    const { Characteristic } = zone.platform;

    // Gets the zone that this instance represents
    const apiZone = apiZones.find(function(z) { return z.id === zone.id; });

    // Updates the battery state
    zone.thermostatService.updateCharacteristic(Characteristic.StatusLowBattery, apiZone.devices.some(function(d) { return d.batteryState !== 'NORMAL'; }));
}

/**
 * Defines the export of the file.
 */
module.exports = TadoHeatingZone;
