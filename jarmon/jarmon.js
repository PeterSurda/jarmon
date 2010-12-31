/**
 * Copyright (c) 2010 Richard Wall <richard (at) the-moon.net>
 * See LICENSE for details.
 *
 * Wrappers and convenience fuctions for working with the javascriptRRD, jQuery,
 * and Flot charting packages.
 *
 * Designed to work well with the RRD files generated by Collectd:
 * - http://collectd.org/
 *
 * Requirements:
 * - JavascriptRRD: http://javascriptrrd.sourceforge.net/
 * - jQuery: http://jquery.com/
 * - Flot: http://code.google.com/p/flot/
 * - MochiKit.Async: http://www.mochikit.com/
 *
 * @module jarmon
 */

/**
 * A namespace for Jarmon
 *
 * @class jarmon
 * @static
 */
if(typeof jarmon == 'undefined') {
    var jarmon = {};
}


jarmon.downloadBinary = function(url) {
    /**
     * Download a binary file asynchronously using the jQuery.ajax function
     *
     * @method downloadBinary
     * @param url {String} The url of the object to be downloaded
     * @return {Object} A deferred which will callback with an instance of javascriptrrd.BinaryFile
     */

    var d = new MochiKit.Async.Deferred();

    $.ajax({
        _deferredResult: d,
        url: url,
        dataType: 'text',
        cache: false,
        beforeSend: function(request) {
            try {
                request.overrideMimeType('text/plain; charset=x-user-defined');
            } catch(e) {
                // IE doesn't support overrideMimeType
            }
        },
        success: function(data) {
            try {
                this._deferredResult.callback(new BinaryFile(data));
            } catch(e) {
                this._deferredResult.errback(e);
            }
        },
        error: function(xhr, textStatus, errorThrown) {
            // Special case for IE which handles binary data slightly
            // differently.
            if(textStatus == 'parsererror') {
                if (typeof xhr.responseBody != 'undefined') {
                    return this.success(xhr.responseBody);
                }
            }
            this._deferredResult.errback(new Error(xhr.status));
        }
    });
    return d;
};


jarmon.localTimeFormatter = function (v, axis) {
    /**
     * Copied from jquery.flot.js and modified to allow timezone
     * adjustment.
     *
     * @method localTimeFormatter
     * @param v {Number} The timestamp to be formatted
     * @param axis {Object} A hash containing information about the time axis
     * @return {String} The formatted datetime string
     **/
    // map of app. size of time units in milliseconds
    var timeUnitSize = {
        "second": 1000,
        "minute": 60 * 1000,
        "hour": 60 * 60 * 1000,
        "day": 24 * 60 * 60 * 1000,
        "month": 30 * 24 * 60 * 60 * 1000,
        "year": 365.2425 * 24 * 60 * 60 * 1000
    };

    // Offset the input timestamp by the user defined amount
    var d = new Date(v + axis.options.tzoffset);

    // first check global format
    if (axis.options.timeformat != null)
        return $.plot.formatDate(d, axis.options.timeformat, axis.options.monthNames);

    var t = axis.tickSize[0] * timeUnitSize[axis.tickSize[1]];
    var span = axis.max - axis.min;
    var suffix = (axis.options.twelveHourClock) ? " %p" : "";

    if (t < timeUnitSize.minute)
        fmt = "%h:%M:%S" + suffix;
    else if (t < timeUnitSize.day) {
        if (span < 2 * timeUnitSize.day)
            fmt = "%h:%M" + suffix;
        else
            fmt = "%b %d %h:%M" + suffix;
    }
    else if (t < timeUnitSize.month)
        fmt = "%b %d";
    else if (t < timeUnitSize.year) {
        if (span < timeUnitSize.year)
            fmt = "%b";
        else
            fmt = "%b %y";
    }
    else
        fmt = "%y";

    return $.plot.formatDate(d, fmt, axis.options.monthNames);
};


/**
 * A wrapper around an instance of javascriptrrd.RRDFile which provides a
 * convenient way to query the RRDFile based on time range, RRD data source (DS)
 * and RRD consolidation function (CF).
 *
 * @class jarmon.RrdQuery
 * @constructor
 * @param rrd {Object} A javascriptrrd.RRDFile
 * @param unit {String} The unit symbol for this data series
 **/
jarmon.RrdQuery = function(rrd, unit) {
    this.rrd = rrd;
    this.unit = unit;
};

jarmon.RrdQuery.prototype.getData = function(startTimeJs, endTimeJs, dsId, cfName) {
    /**
     * Generate a Flot compatible data object containing rows between start and
     * end time. The rows are taken from the first RRA whose data spans the
     * requested time range.
     *
     * @method getData
     * @param startTimeJs {Number} start timestamp in microseconds
     * @param endTimeJs {Number} end timestamp in microseconds
     * @param dsId {Variant} identifier of the RRD datasource (string or number)
     * @param cfName {String} The name of an RRD consolidation function (CF)
     *      eg AVERAGE, MIN, MAX
     * @return {Object} A Flot compatible data series
     *      eg label: '', data: [], unit: ''
     **/

    if (startTimeJs >= endTimeJs) {
        throw RangeError(
            ['starttime must be less than endtime. ',
             'starttime: ', startTimeJs,
             'endtime: ', endTimeJs].join(''));
    }

    var startTime = startTimeJs/1000;
    var lastUpdated = this.rrd.getLastUpdate();

    // default endTime to the last updated time (quantized to rrd step boundry)
    var endTime = lastUpdated - lastUpdated%this.rrd.getMinStep();
    if(endTimeJs) {
        endTime = endTimeJs/1000;
    }

    if(dsId == null) {
        dsId = 0;
    }
    var ds = this.rrd.getDS(dsId);

    if(cfName == null) {
        cfName = 'AVERAGE';
    }

    var rra, step, rraRowCount, lastRowTime, firstRowTime;

    for(var i=0; i<this.rrd.getNrRRAs(); i++) {
        // Look through all RRAs looking for the most suitable
        // data resolution.
        rra = this.rrd.getRRA(i);

        // If this rra doesn't use the requested CF then move on to the next.
        if(rra.getCFName() != cfName) {
            continue;
        }

        step = rra.getStep();
        rraRowCount = rra.getNrRows();
        lastRowTime = lastUpdated-lastUpdated%step;
        firstRowTime = lastRowTime - rraRowCount * step;

        // We assume that the RRAs are listed in ascending order of time range,
        // therefore the first RRA which contains the range minimum should give
        // the highest resolution data for this range.
        if(firstRowTime <= startTime) {
            break;
        }
    }
    // If we got to the end of the loop without ever defining step, it means
    // that the CF check never succeded.
    if(!step) {
        throw TypeError('Unrecognised consolidation function: ' + cfName);
    }

    var flotData = [];
    var dsIndex = ds.getIdx();

    var startRowTime = Math.max(firstRowTime, startTime - startTime%step);
    var endRowTime = Math.min(lastRowTime, endTime - endTime%step);
    // If RRD exists, but hasn't been updated then the start time might end up
    // being higher than the end time (which is capped at the last row time of
    // the chosen RRA, so cap startTime at endTime...if you see what I mean)
    startRowTime = Math.min(startRowTime, endRowTime);

    /*
    console.log('FRT: ', new Date(firstRowTime*1000));
    console.log('LRT: ', new Date(lastRowTime*1000));
    console.log('SRT: ', new Date(startRowTime*1000));
    console.log('ERT: ', new Date(endRowTime*1000));
    console.log('DIFF: ', (lastRowTime - startRowTime) / step);
    console.log('ROWS: ', rraRowCount);
    */

    var startRowIndex = rraRowCount - (lastRowTime - startRowTime)  / step;
    var endRowIndex = rraRowCount - (lastRowTime - endRowTime)  / step;

    //console.log('SRI: ', startRowIndex);
    //console.log('ERI: ', endRowIndex);

    var val;
    var timestamp = startRowTime;
    for(var i=startRowIndex; i<endRowIndex; i++) {
        val = rra.getEl(i, dsIndex)
        flotData.push([timestamp*1000.0, val]);
        timestamp += step
    }

    // Now get the date of the earliest record in entire rrd file, ie that of
    // the last (longest range) rra.
    rra = this.rrd.getRRA(this.rrd.getNrRRAs()-1);
    firstUpdated = lastUpdated - (rra.getNrRows() -1) * rra.getStep();

    return {'label': ds.getName(), 'data': flotData, 'unit': this.unit,
            'firstUpdated': firstUpdated*1000.0,
            'lastUpdated': lastUpdated*1000.0};
};


jarmon.RrdQuery.prototype.getDSNames = function() {
    /**
     * Return a list of RRD Data Source names
     *
     * @method getDSNames
     * @return {Array} An array of DS names.
     **/
    return this.rrd.getDSNames();
};


/**
 * A wrapper around RrdQuery which provides asynchronous access to the data in a
 * remote RRD file.
 *
 * @class jarmon.RrdQueryRemote
 * @constructor
 * @param url {String} The url of a remote RRD file
 * @param unit {String} The unit suffix of this data eg 'bit/sec'
 * @param downloader {Function} A callable which returns a Deferred and calls
 *      back with a javascriptrrd.BinaryFile when it has downloaded.
 **/
jarmon.RrdQueryRemote = function(url, unit, downloader) {
    this.url = url;
    this.unit = unit;
    this.downloader = downloader || jarmon.downloadBinary;
    this.lastUpdate = 0;
    this._download = null;
};


jarmon.RrdQueryRemote.prototype._callRemote = function(methodName, args) {
    // Download the rrd if there has never been a download and don't start
    // another download if one is already in progress.
    if(!this._download) {
        this._download = this.downloader(this.url)
                .addCallback(
                    function(self, binary) {
                        // Upon successful download convert the resulting binary
                        // into an RRD file and pass it on to the next callback
                        // in the chain.
                        var rrd = new RRDFile(binary);
                        self.lastUpdate = rrd.getLastUpdate();
                        return rrd;
                    }, this);
    }

    // Set up a deferred which will call getData on the local RrdQuery object
    // returning a flot compatible data object to the caller.
    var ret = new MochiKit.Async.Deferred().addCallback(
        function(self, methodName, args, rrd) {
            var rq = new jarmon.RrdQuery(rrd, self.unit);
            return rq[methodName].apply(rq, args);
        }, this, methodName, args);

    // Add a pair of callbacks to the current download which will callback the
    // result which we setup above.
    this._download.addBoth(
        function(ret, res) {
            if(res instanceof Error) {
                ret.errback(res);
            } else {
                ret.callback(res);
            }
            return res;
        }, ret);

    return ret;
};


jarmon.RrdQueryRemote.prototype.getData = function(startTime, endTime, dsId, cfName) {
    /**
     * Return a Flot compatible data series asynchronously.
     *
     * @method getData
     * @param startTime {Number} The start timestamp
     * @param endTime {Number} The end timestamp
     * @param dsId {Variant} identifier of the RRD datasource (string or number)
     * @return {Object} A Deferred which calls back with a flot data series.
     **/
    if(this.lastUpdate < endTime/1000) {
        this._download = null;
    }
    return this._callRemote('getData', [startTime, endTime, dsId, cfName]);
};


jarmon.RrdQueryRemote.prototype.getDSNames = function() {
    /**
     * Return a list of RRD Data Source names
     *
     * @method getDSNames
     * @return {Object} A Deferred which calls back with an array of DS names.
     **/
    return this._callRemote('getDSNames');
};


/**
 * Wraps RrdQueryRemote to provide access to a different RRD DSs within a
 * single RrdDataSource.
 *
 * @class jarmon.RrdQueryDsProxy
 * @constructor
 * @param rrdQuery {Object} An RrdQueryRemote instance
 * @param dsId {Variant} identifier of the RRD datasource (string or number)
 **/
jarmon.RrdQueryDsProxy = function(rrdQuery, dsId) {
    this.rrdQuery = rrdQuery;
    this.dsId = dsId;
    this.unit = rrdQuery.unit;
};

jarmon.RrdQueryDsProxy.prototype.getData = function(startTime, endTime) {
    /**
     * Call I{RrdQueryRemote.getData} with a particular dsId
     *
     * @method getData
     * @param startTime {Number} A unix timestamp marking the start time
     * @param endTime {Number} A unix timestamp marking the start time
     * @return {Object} A Deferred which calls back with a flot data series.
     **/
    return this.rrdQuery.getData(startTime, endTime, this.dsId);
};


/**
 * A class for creating a Flot chart from a series of RRD Queries
 *
 * @class jarmon.Chart
 * @constructor
 * @param template {Object} A jQuery containing a single element into which the
 *      chart will be drawn
 * @param options {Object} Flot options which control how the chart should be
 *      drawn.
 **/
jarmon.Chart = function(template, options) {
    this.template = template;
    this.options = jQuery.extend(true, {yaxis: {}}, options);

    this.data = [];

    var self = this;


    // Listen for clicks on the legend items - onclick enable / disable the
    // corresponding data source.
    $('.graph-legend .legendItem', this.template[0]).live('click', function(e) {
        self.switchDataEnabled($(this).text());
        self.draw();
    });


    this.options['yaxis']['ticks'] = function(axis) {
        /*
         * Choose a suitable SI multiplier based on the min and max values from
         * the axis and then generate appropriate yaxis tick labels.
         *
         * @param axis: An I{Object} with min and max properties
         * @return: An array of ~5 tick labels
         */
        var siPrefixes = {
            0: '',
            1: 'K',
            2: 'M',
            3: 'G',
            4: 'T'
        }
        var si = 0;
        while(true) {
            if( Math.pow(1000, si+1)*0.9 > axis.max ) {
                break;
            }
            si++;
        }

        var minVal = axis.min/Math.pow(1000, si);
        var maxVal = axis.max/Math.pow(1000, si);

        var stepSizes = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 10, 25, 50, 100, 250];
        var realStep = (maxVal - minVal)/5.0;

        var stepSize, decimalPlaces = 0;
        for(var i=0; i<stepSizes.length; i++) {
            stepSize = stepSizes[i]
            if( realStep < stepSize ) {
                if(stepSize < 10) {
                    decimalPlaces = 2;
                }
                break;
            }
        }

        if(self.options.yaxis.tickDecimals != null) {
            decimalPlaces = self.options.yaxis.tickDecimals;
        }

        var tickMin = minVal - minVal % stepSize;
        var tickMax = maxVal - maxVal % stepSize + stepSize

        var ticks = [];
        for(var j=tickMin; j<=tickMax; j+=stepSize) {
            ticks.push([
                j*Math.pow(1000, si),
                j.toFixed(decimalPlaces)
            ]);
        }

        self.siPrefix = siPrefixes[si];

        return ticks;
    };
};

jarmon.Chart.prototype.addData = function(label, db, enabled) {
    /**
     * Add details of a remote RRD data source whose data will be added to this
     * chart.
     *
     * @method addData
     * @param label {String} The label for this data which will be shown in the
     *               chart legend
     * @param db {String} The url of the remote RRD database
     * @param enabled {Boolean} true if you want this data plotted on the chart,
     *      false if not.
     **/
    if(typeof enabled == 'undefined') {
        enabled = true;
    }
    this.data.push([label, db, enabled]);
};

jarmon.Chart.prototype.switchDataEnabled = function(label) {
    /**
     * Enable / Disable a single data source
     *
     * @method switchDataEnabled
     * @param label {String} The label of the data source to be enabled /
     *      disabled.
     **/
    for(var i=0; i<this.data.length; i++) {
        if(this.data[i][0] == label) {
            this.data[i][2] = !this.data[i][2];
        }
    }
};

jarmon.Chart.prototype.setTimeRange = function(startTime, endTime) {
    /**
     * Alter the time range of this chart and redraw
     *
     * @method setTimeRange
     * @param startTime {Number} The start timestamp
     * @param endTime {Number} The end timestamp
     **/
    this.startTime = startTime;
    this.endTime = endTime;
    return this.draw();
}

jarmon.Chart.prototype.draw = function() {
    /**
     * Draw the chart
     * A 'chart_loading' event is triggered before the data is requested
     * A 'chart_loaded' event is triggered when the chart has been drawn
     *
     * @method draw
     * @return {Object} A Deferred which calls back with the chart data when
     *      the chart has been rendered.
     **/
    this.template.addClass('loading');

    var result;
    var results = [];
    for(var i=0; i<this.data.length; i++) {
        if(this.data[i][2]) {
            result = this.data[i][1].getData(this.startTime, this.endTime);
        } else {
            // If the data source has been marked as disabled return a fake
            // empty dataset
            // 0 values so that it can contribute to a stacked chart.
            // 0 linewidth so that it doesn't cause a line in stacked chart
            result = new MochiKit.Async.Deferred();
            result.callback({
                data: [
                    [this.startTime, 0],
                    [this.endTime, 0]
                ],
                lines: {
                    lineWidth: 0
                }
            });
        }

        results.push(result);
    }

    return MochiKit.Async.gatherResults(results)
            .addCallback(
                function(self, data) {
                    // Clear any previous error messages.
                    self.template.find('.error').empty().hide();

                    var i, label, disabled = [];
                    unit = '';
                    for(i=0; i<data.length; i++) {
                        label = self.data[i][0];
                        if(label) {
                            data[i].label = label;
                        }
                        if(typeof data[i].unit != 'undefined') {
                            // Just use the last unit for now
                            unit = data[i].unit;
                        }
                        if(!self.data[i][2]) {
                            disabled.push(label);
                        }
                    }

                    $.plot(self.template.find('.chart').empty().show(), data, self.options);

                    var yaxisUnitLabel = $('<div>').text(self.siPrefix + unit)
                                                   .css({width: '100px',
                                                         position: 'absolute',
                                                         top: '80px',
                                                         left: '-90px',
                                                         'text-align': 'right'});
                    self.template.find('.chart').append(yaxisUnitLabel);

                    // Manipulate and move the flot generated legend to an
                    // alternative position.
                    // The default legend is formatted as an HTML table, so we
                    // grab the contents of the cells and turn them into
                    // divs.
                    // Actually, formatting the legend first as a one column
                    // table is useful as it generates an optimum label element
                    // width which we can copy to the new divs + a little extra
                    // to accomodate the color box
                    var legend = self.template.find('.graph-legend').show();
                    legend.empty();
                    self.template.find('.legendLabel')
                        .each(function(i, el) {
                            var orig = $(el);
                            var label = orig.text();
                            var newEl = $('<div />')
                                .attr('class', 'legendItem')
                                .attr('title', 'Data series switch - click to turn this data series on or off')
                                .width(orig.width()+20)
                                .text(label)
                                .prepend(orig.prev().find('div div').clone().addClass('legendColorBox'))
                                .appendTo(legend);
                            // The legend label is clickable - to enable /
                            // disable different data series. The disabled class
                            // results in a label formatted with strike though
                            if( $.inArray(label, disabled) > -1 ) {
                                newEl.addClass('disabled');
                            }
                        })
                        .remove();
                    legend.append($('<div />').css('clear', 'both'));
                    self.template.find('.legend').remove();

                    yaxisUnitLabel.position(self.template.position());
                    return data;
                }, this)
            .addErrback(
                function(self, failure) {
                    self.template.find('.chart').empty().hide();
                    self.template.find('.graph-legend').empty().hide();
                    self.template.find('.error').text('error: ' + failure.message);

                }, this)
            .addBoth(
                function(self, res) {
                    self.template.removeClass('loading');
                    return res;
                }, this);
};


jarmon.Chart.fromRecipe = function(recipes, templateFactory, downloader) {
    /**
     * A static factory method to generate a list of I{Chart} from a list of
     * recipes and a list of available rrd files in collectd path format.
     *
     * @method fromRecipe
     * @param recipes {Array} A list of recipe objects.
     * @param templateFactory {Function} A callable which generates an html
     *      template for a chart.
     * @param downloader {Function} A download function which returns a Deferred
     * @return {Array} A list of Chart objects
     **/

    var charts = [];
    var dataDict = {};

    var recipe, chartData, template, c, i, j, ds, label, rrd, unit, re, match;

    for(i=0; i<recipes.length; i++) {
        recipe = recipes[i];
        chartData = [];

        for(j=0; j<recipe['data'].length; j++) {
            rrd = recipe['data'][j][0];
            ds = recipe['data'][j][1];
            label = recipe['data'][j][2];
            unit = recipe['data'][j][3];
            if(typeof dataDict[rrd] == 'undefined') {
                dataDict[rrd] = new jarmon.RrdQueryRemote(rrd, unit, downloader);
            }
            chartData.push([label, new jarmon.RrdQueryDsProxy(dataDict[rrd], ds)]);
        }
        if(chartData.length > 0) {
            template = templateFactory();
            template.find('.title').text(recipe['title']);
            c = new jarmon.Chart(template, recipe['options']);
            for(j=0; j<chartData.length; j++) {
                c.addData.apply(c, chartData[j]);
            }
            charts.push(c);
        }
    }
    return charts;
};


/**
 * Generate a form through which to manipulate the data sources for a chart
 *
 * @class jarmon.ChartConfig
 * @constructor
 **/
jarmon.ChartConfig = function($tpl) {
    this.$tpl = $tpl;
    this.data = {
        rrdUrl: '',
        dsName: '',
        dsLabel: '',
        dsUnit:''
    };
};

jarmon.ChartConfig.prototype.drawRrdUrlForm = function() {
    var self = this;
    this.$tpl.empty();

    $('<form/>').append(
        $('<div/>').append(
            $('<p/>').text('Enter the URL of an RRD file'),
            $('<label/>').append(
                'URL: ',
                $('<input/>', {
                    type: 'text',
                    name: 'rrd_url',
                    value: this.data.rrdUrl
                })
            ),
            $('<input/>', {type: 'submit', value: 'download'}),
            $('<div/>', {class: 'next'})
        )
    ).submit(
        function(e) {
            self.data.rrdUrl = this['rrd_url'].value;
            $placeholder = $(this).find('.next').empty();
            new jarmon.RrdQueryRemote(self.data.rrdUrl).getDSNames().addCallback(
                function($placeholder, dsNames) {
                    if(dsNames.length > 1) {
                        $('<p/>').text(
                            'The RRD file contains multiple data sources. \
                             Choose one:').appendTo($placeholder);

                        $(dsNames).map(
                            function(i, el) {
                                return $('<input/>', {
                                    type: 'button',
                                    value: el
                                }
                            ).click(
                                function(e) {
                                    self.data.dsName = this.value;
                                    self.drawDsLabelForm();
                                }
                            );
                        }).appendTo($placeholder);
                    } else {
                        self.data.dsName = dsNames[0];
                        self.drawDsLabelForm();
                    }
                }, $placeholder
            ).addErrback(
                function($placeholder, err) {
                    $('<p/>', {'class': 'error'}).text(err.toString()).appendTo($placeholder);
                }, $placeholder
            );
            return false;
        }
    ).appendTo(this.$tpl);
}

jarmon.ChartConfig.prototype.drawDsLabelForm = function() {
    var self = this;
    this.$tpl.empty();

    $('<form/>').append(
        $('<p/>').text('Choose a label and unit for this data source.'),
        $('<div/>').append(
            $('<label/>').append(
                'Label: ',
                $('<input/>', {
                    type: 'text',
                    name: 'dsLabel',
                    value: this.data.dslabel || this.data.dsName
                })
            )
        ),
        $('<div/>').append(
            $('<label/>').append(
                'Unit: ',
                $('<input/>', {
                    type: 'text',
                    name: 'dsUnit',
                    value: this.data.dsUnit
                })
            )
        ),
        $('<input/>', {type: 'button', value: 'back'}).click(
            function(e) {
                self.drawRrdUrlForm();
            }
        ),
        $('<input/>', {type: 'submit', value: 'save'}),
        $('<div/>', {class: 'next'})
    ).submit(
        function(e) {
            self.data.dsLabel = this['dsLabel'].value;
            self.data.dsUnit = this['dsUnit'].value;
            self.drawDsSummary();
            return false;
        }
    ).appendTo(this.$tpl);
};


jarmon.ChartConfig.prototype.drawDsSummary = function() {
    var self = this;
    this.$tpl.empty();

    jQuery.each(this.data, function(i, el) {
        $('<p/>').append(
            $('<strong/>').text(i),
            [': ', el].join('')
        ).appendTo(self.$tpl);
    });

    this.$tpl.append(
        $('<input/>', {type: 'button', value: 'back'}).click(
            function(e) {
                self.drawDsLabelForm();
            }
        ),
        $('<input/>', {type: 'button', value: 'finish'})
    );
};


// Options common to all the chart on this page
jarmon.Chart.BASE_OPTIONS = {
    grid: {
        clickable: false,
        borderWidth: 1,
        borderColor: "#000",
        color: "#000",
        backgroundColor: "#fff",
        tickColor: "#eee"
    },
    legend: {
        position: 'nw',
        noColumns: 1
    },
    selection: {
        mode: 'x'
    },
    series: {
        points: { show: false },
        lines: {
            show: true,
            steps: false,
            shadowSize: 0,
            lineWidth: 1
        },
        shadowSize: 0
    },
    xaxis: {
        mode: "time",
        tickFormatter: jarmon.localTimeFormatter
    }
};

// Extra options to generate a stacked chart
jarmon.Chart.STACKED_OPTIONS = {
    series: {
        stack: true,
        lines: {
            fill: 0.5
        }
    }
};


// A selection of useful time ranges
jarmon.timeRangeShortcuts = [
    ['last hour', function(now) { return [now-60*60*1000*1, now]; }],
    ['last 3 hours', function(now) { return [now-60*60*1000*3, now]; }],
    ['last 6 hours', function(now) { return [now-60*60*1000*6, now]; }],
    ['last 12 hours', function(now) { return [now-60*60*1000*12, now]; }],
    ['last day', function(now) { return [now-60*60*1000*24, now]; }],
    ['last week', function(now) { return [now-60*60*1000*24*7, now]; }],
    ['last month', function(now) { return [now-60*60*1000*24*31, now]; }],
    ['last year', function(now) { return [now-60*60*1000*24*365, now]; }]
];


/**
 * Presents the user with a form and a timeline with which they can choose a
 * time range and co-ordinates the refreshing of a series of charts.
 *
 * @class jarmon.ChartCoordinator
 * @constructor
 * @param ui {Object} A one element jQuery containing an input form and
 *      placeholders for the timeline and for the series of charts.
 **/
jarmon.ChartCoordinator = function(ui) {
    var self = this;
    this.ui = ui;
    this.charts = [];

    // Style and configuration of the range timeline
    this.rangePreviewOptions = {
        grid: {
            borderWidth: 1
        },
        selection: {
            mode: 'x'
        },
        xaxis: {
            mode: 'time',
            tickFormatter: jarmon.localTimeFormatter
        },
        yaxis: {
            ticks: []
        }
    };

    var options = this.ui.find('select[name="from_standard"]');
    for(var i=0; i<jarmon.timeRangeShortcuts.length; i++) {
        options.append($('<option />').text(jarmon.timeRangeShortcuts[i][0]));
    }

    // Append a custom option for when the user selects an area of the graph
    options.append($('<option />').text('custom'));
    // Select the first shortcut by default
    options.val(jarmon.timeRangeShortcuts[0][0]);

    options.bind('change', function(e) {
        // No point in updating if the user chose custom.
        if($(this).val() != 'custom') {
            self.update();
        }
    });

    // Update the time ranges and redraw charts when the custom datetime inputs
    // are changed
    this.ui.find('[name="from_custom"]').bind('change',
        function(e) {
            self.ui.find('[name="from_standard"]').val('custom');
            var tzoffset = parseInt(self.ui.find('[name="tzoffset"]').val());
            self.setTimeRange(new Date(this.value + ' UTC').getTime() - tzoffset, null);
            self.update();
        }
    );

    this.ui.find('[name="to_custom"]').bind('change',
        function(e) {
            self.ui.find('[name="from_standard"]').val('custom');
            var tzoffset = parseInt(self.ui.find('[name="tzoffset"]').val());
            self.setTimeRange(null, new Date(this.value + ' UTC').getTime() - tzoffset);
            self.update();
        }
    );

    // Populate a list of tzoffset options if the element is present in the
    // template as a select list
    tzoffsetEl = this.ui.find('[name="tzoffset"]');
    if(tzoffsetEl.is('select')) {
        var label, val;
        for(var i=-12; i<=12; i++) {
            label = 'UTC';
            val = i;
            if(val >= 0) {
                label += ' + ';
            } else {
                label += ' - ';
            }
            val = Math.abs(val).toString();
            if(val.length == 1) {
                label += '0';
            }
            label += val + '00';
            tzoffsetEl.append($('<option />').attr('value', i*60*60*1000).text(label));
        }

        tzoffsetEl.bind('change', function(e) {
            self.update();
        });
    }

    // Default timezone offset based on localtime
    var tzoffset = -1 * new Date().getTimezoneOffset() * 60 * 1000;
    tzoffsetEl.val(tzoffset);

    // Update the time ranges and redraw charts when the form is submitted
    this.ui.find('[name="action"]').bind('click', function(e) {
        self.update();
        return false;
    });

    // When a selection is made on the range timeline, or any of my charts
    // redraw all the charts.
    this.ui.bind("plotselected", function(event, ranges) {
        self.ui.find('[name="from_standard"]').val('custom');
        self.setTimeRange(ranges.xaxis.from, ranges.xaxis.to);
        self.update();
    });
};


jarmon.ChartCoordinator.prototype.update = function() {
    /**
     * Grab the start and end time from the ui form, highlight the range on the
     * range timeline and set the time range of all the charts and redraw.
     *
     * @method update
     **/

    var selection = this.ui.find('[name="from_standard"]').val();

    var now = new Date().getTime();
    for(var i=0; i<jarmon.timeRangeShortcuts.length; i++) {
        if(jarmon.timeRangeShortcuts[i][0] == selection) {
            range = jarmon.timeRangeShortcuts[i][1](now);
            this.setTimeRange(range[0], range[1]);
            break;
        }
    }

    var startTime = parseInt(this.ui.find('[name="from"]').val());
    var endTime = parseInt(this.ui.find('[name="to"]').val());
    var tzoffset = parseInt(this.ui.find('[name="tzoffset"]').val());

    this.ui.find('[name="from_custom"]').val(
        new Date(startTime + tzoffset).toUTCString().split(' ').slice(1,5).join(' '));
    this.ui.find('[name="to_custom"]').val(
        new Date(endTime + tzoffset).toUTCString().split(' ').slice(1,5).join(' '));

    this.rangePreviewOptions.xaxis.tzoffset = tzoffset;

    var chartsLoading = [];
    for(var i=0; i<this.charts.length; i++){
        this.charts[i].options.xaxis.tzoffset = tzoffset;
        // Don't render charts which are not currently visible
        if(this.charts[i].template.is(':visible')) {
            chartsLoading.push(
                this.charts[i].setTimeRange(startTime, endTime));
        }
    }
    return MochiKit.Async.gatherResults(chartsLoading).addCallback(
        function(self, startTime, endTime, chartData) {

            var firstUpdate = new Date().getTime();
            var lastUpdate = 0;

            for(var i=0; i<chartData.length; i++) {
                for(var j=0; j<chartData[i].length; j++) {
                    if(chartData[i][j].firstUpdated < firstUpdate) {
                        firstUpdate = chartData[i][j].firstUpdated;
                    }
                    if(chartData[i][j].lastUpdated > lastUpdate) {
                        lastUpdate = chartData[i][j].lastUpdated;
                    }
                }
            }

            var ranges = {
                xaxis: {
                    from: Math.max(startTime, firstUpdate),
                    to: Math.min(endTime, lastUpdate)
                }
            };

            // Add a suitable extended head and tail to preview graph time axis
            var HOUR = 1000 * 60 * 60;
            var DAY = HOUR * 24;
            var WEEK = DAY * 7;
            var MONTH = DAY * 31;
            var YEAR = DAY * 365;
            var periods = [HOUR, HOUR*6, HOUR*12,
                           DAY, DAY*3,
                           WEEK, WEEK*2,
                           MONTH, MONTH*3, MONTH*6, YEAR];

            var range = ranges.xaxis.to - ranges.xaxis.from;
            for(var i=0; i<periods.length; i++) {
                if(range <= periods[i]) {
                    i++;
                    break;
                }
            }

            // Dummy data for the range timeline
            var data = [
                [Math.max(ranges.xaxis.from - periods[i-1], firstUpdate), 1],
                [Math.min(ranges.xaxis.to + periods[i-1], lastUpdate), 1]];

            self.rangePreview = $.plot(self.ui.find('.range-preview'), [data],
                                       self.rangePreviewOptions);

            self.rangePreview.setSelection(ranges, true);
        }, this, startTime, endTime);
};

jarmon.ChartCoordinator.prototype.setTimeRange = function(from, to) {
    /**
     * Set the start and end time fields in the form and trigger an update
     *
     * @method setTimeRange
     * @param startTime {Number} The start timestamp
     * @param endTime {Number} The end timestamp
     **/
    if(from != null) {
        this.ui.find('[name="from"]').val(from);
    }
    if(to != null) {
        this.ui.find('[name="to"]').val(to);
    }
};

jarmon.ChartCoordinator.prototype.init = function() {
    /**
     * Reset all charts and the input form to the default time range - last hour
     *
     * @method init
     **/
    this.update();
};

/**
 * Limit the number of parallel async calls
 *
 * @class jarmon.Parallimiter
 * @constructor
 * @param limit {Number} The maximum number of in progress calls
 **/
jarmon.Parallimiter = function(limit) {
    this.limit = limit || 1;
    this._callQueue = [];
    this._currentCallCount = 0;
};

jarmon.Parallimiter.prototype.addCallable = function(callable, args) {
    /**
    * Add a function to be called when the number of in progress calls drops
    * below the configured limit
    *
    * @method addCallable
    * @param callable {Function} A function which returns a Deferred.
    * @param args {Array} A list of arguments to pass to the callable
    * @return {Object} A Deferred which fires with the result of the callable
    *       when it is called.
    **/
    var d = new MochiKit.Async.Deferred();
    this._callQueue.unshift([d, callable, args]);
    this._nextCall();
    return d;
};

jarmon.Parallimiter.prototype._nextCall = function() {
    if(this._callQueue.length > 0) {
        if(this._currentCallCount < this.limit) {
            this._currentCallCount++;
            var nextCall = this._callQueue.pop();
            nextCall[1].apply(null, nextCall[2]).addBoth(
                function(self, d, res) {
                    d.callback(res);
                    self._currentCallCount--;
                    self._nextCall();
                }, this, nextCall[0]);
        }
    }
};
