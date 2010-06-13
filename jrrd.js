/* Copyright (c) 2010 Richard Wall <richard (at) the-moon.net>
 * See LICENSE for details.
 *
 * Wrappers and convenience fuctions for working with the javascriptRRD, jQuery,
 * and flot charting packages.
 *
 * Designed to work well with the RRD files generated by Collectd:
 * - http://collectd.org/
 *
 * Requirements:
 * - JavascriptRRD: http://javascriptrrd.sourceforge.net/
 * - jQuery: http://jquery.com/
 * - Flot: http://code.google.com/p/flot/
 * - MochiKit.Async: http://www.mochikit.com/
 */

if(typeof jrrd == 'undefined') {
    var jrrd = {};
}

/**
 * Download a binary file asynchronously using the jQuery.ajax function
 *
 * @param url: The url of the object to be downloaded
 * @return: A I{MochiKit.Async.Deferred} which will callback with an instance of
 *          I{javascriptrrd.BinaryFile}
 **/
jrrd.downloadBinary = function(url) {
    var d = new MochiKit.Async.Deferred();

    $.ajax({
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
                d.callback(new BinaryFile(data));
            } catch(e) {
                d.errback(e);
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
            d.errback(new Error(xhr.status));
        }
    });
    return d;
};

/**
 * A wrapper around an instance of javascriptrrd.RRDFile which provides a
 * convenient way to query the RRDFile based on time range, RRD data source (DS)
 * and RRD consolidation function (CF).
 *
 * @param startTime: A javascript {Date} instance representing the start of query
 *                   time range, or {null} to return earliest available data.
 * @param endTime: A javascript {Date} instance representing the end of query
 *                   time range, or {null} to return latest available data.
 * @param dsId: A {String} name of an RRD DS or an {Int} DS index number or
 *              {null} to return the first available DS.
 * @param cfName: A {String} name of an RRD consolidation function
 * @return: A flot compatible data series object
 **/
jrrd.RrdQuery = function(rrd, unit) {
    this.rrd = rrd;
    this.unit = unit;
};

jrrd.RrdQuery.prototype.getData = function(startTime, endTime, dsId, cfName) {
    /**
     * Generate a Flot compatible data object containing rows between start and
     * end time. The rows are taken from the first RRA whose data spans the
     * requested time range.
     *
     * @param startTime: The I{Date} start time
     * @param endTime: The I{Date} end time
     * @param dsId: An index I{Number} or key I{String} identifying the RRD
     *              datasource (DS).
     * @param cfName: The name I{String} of an RRD consolidation function (CF)
     *                eg AVERAGE, MIN, MAX
     * @return: A Flot compatible data series I{Object}
     *          eg {label:'', data:[], unit: ''}
     **/
    var startTimestamp = startTime.getTime()/1000;

    var lastUpdated = this.rrd.getLastUpdate();
    var endTimestamp = lastUpdated;
    if(endTime) {
        endTimestamp = endTime.getTime()/1000;
        // If end time stamp is beyond the range of this rrd then reset it
        if(lastUpdated < endTimestamp) {
            endTimestamp = lastUpdated;
        }
    }

    if(dsId == null) {
        dsId = 0;
    }
    var ds = this.rrd.getDS(dsId);

    if(cfName == null) {
        cfName = 'AVERAGE';
    }

    var rra, step, rraRowCount, firstUpdated;

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
        firstUpdated = lastUpdated - (rraRowCount - 1) * step;
        // We assume that the RRAs are listed in ascending order of time range,
        // therefore the first RRA which contains the range minimum should give
        // the highest resolution data for this range.
        if(firstUpdated <= startTimestamp) {
            break;
        }
    }
    // If we got to the end of the loop without ever defining step, it means
    // that the CF check never succeded.
    if(!step) {
        throw new Error('Unrecognised consolidation function: ' + cfName);
    }

    var startRow = rraRowCount - parseInt((lastUpdated - Math.max(startTimestamp, firstUpdated))/step) - 1;
    var endRow = rraRowCount - parseInt((lastUpdated - endTimestamp)/step) - 1;

    var flotData = [];
    var timestamp = firstUpdated + (startRow - 1) * step;
    var dsIndex = ds.getIdx();
    for (var i=startRow; i<=endRow; i++) {
        flotData.push([timestamp*1000.0, rra.getEl(i, dsIndex)]);
        timestamp += step;
    }

    // Now get the date of the earliest record in entire rrd file, ie that of
    // the last (longest range) rra.
    rra = this.rrd.getRRA(this.rrd.getNrRRAs()-1);
    firstUpdated = lastUpdated - (rra.getNrRows() -1) * rra.getStep();

    return {'label': ds.getName(), 'data': flotData, 'unit': this.unit,
            'firstUpdated': firstUpdated*1000.0,
            'lastUpdated': lastUpdated*1000.0};
};

/**
 * A wrapper around RrdQuery which provides asynchronous access to the data in a
 * remote RRD file.
 *
 * @param url: The url I{String} of a remote RRD file
 * @param unit: The unit suffix I{String} of this data eg 'bit/sec'
 **/
jrrd.RrdQueryRemote = function(url, unit) {
    this.url = url;
    this.unit = unit;
    this.lastUpdate = 0;
    this._download = null;
};

jrrd.RrdQueryRemote.prototype.getData = function(startTime, endTime, dsId) {
    /**
     * Return a Flot compatible data series asynchronously.
     *
     * @param startTime: The start time I{Date}
     * @param endTime: The end time I{Date}
     * @returns: A I{MochiKit.Async.Deferred} which calls back with a flot data
     *           series object I{Object}
     **/
    var endTimestamp = endTime.getTime()/1000;

    // Download the rrd if there has never been a download or if the last
    // completed download had a lastUpdated timestamp less than the requested
    // end time.
    // Don't start another download if one is already in progress.
    if(!this._download || (this._download.fired > -1 && this.lastUpdate < endTimestamp )) {
        this._download = jrrd.downloadBinary(this.url)
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
        function(self, startTime, endTime, dsId, rrd) {
            return new jrrd.RrdQuery(rrd, self.unit).getData(startTime, endTime, dsId);
        }, this, startTime, endTime, dsId);

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

/**
 * Wraps a I{RrdQueryRemote} to provide access to a different RRD DSs within a
 * single RrdDataSource.
 *
 * @param rrdQuery: An I{RrdQueryRemote}
 * @param dsId: An index or keyname of an RRD DS
 **/
jrrd.RrdQueryDsProxy = function(rrdQuery, dsId) {
    this.rrdQuery = rrdQuery;
    this.dsId = dsId;
    this.unit = rrdQuery.unit;
};

jrrd.RrdQueryDsProxy.prototype.getData = function(startTime, endTime) {
    /**
     * Call I{RrdQueryRemote.getData} with a particular dsId
     **/
    return this.rrdQuery.getData(startTime, endTime, this.dsId);
};


/**
 * A class for creating a Flot chart from a series of RRD Queries
 *
 * @param template: A I{jQuery} containing a single element into which the chart
 *                  will be drawn
 * @param options: An I{Object} containing Flot options which describe how the
 *                 chart should be drawn.
 **/
jrrd.Chart = function(template, options) {
    this.template = template;
    this.options = jQuery.extend(true, {yaxis: {}}, options);
    this.data = [];

    var self = this;


    // Listen for clicks on the legend items - onclick enable / disable the
    // corresponding data source.
    $('.legend .legendLabel', this.template[0]).live('click', function(e) {
        self.switchDataEnabled($(this).text());
        self.draw();
    });


    this.options['yaxis']['ticks'] = function(axis) {
        /**
         * Choose a suitable SI multiplier based on the min and max values from
         * the axis and then generate appropriate yaxis tick labels.
         *
         * @param axis: An I{Object} with min and max properties
         * @return: An array of ~5 tick labels
         **/
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

        var tickMin = minVal - minVal % stepSize;
        var tickMax = maxVal - maxVal % stepSize + stepSize

        var ticks = [];
        for(var j=tickMin; j<=tickMax; j+=stepSize) {
            ticks.push([j*Math.pow(1000, si), j.toFixed(decimalPlaces)]);
        }

        self.siPrefix = siPrefixes[si];

        return ticks;
    };
};

jrrd.Chart.prototype.addData = function(label, db, enabled) {
    /**
     * Add details of a remote RRD data source whose data will be added to this
     * chart.
     *
     * @param label: A I{String} label for this data which will be shown in the
     *               chart legend
     * @param db: The url of the remote RRD database
     * @param enabled: true if you want this data plotted on the chart, false
     *                 if not.
     **/
    if(typeof enabled == 'undefined') {
        enabled = true;
    }
    this.data.push([label, db, enabled]);
};

jrrd.Chart.prototype.switchDataEnabled = function(label) {
    /**
     * Enable / Disable a single data source
     *
     * @param label: The label I{String} of the data source to be enabled /
     *               disabled
     **/
    for(var i=0; i<this.data.length; i++) {
        if(this.data[i][0] == label) {
            this.data[i][2] = !this.data[i][2];
        }
    }
};

jrrd.Chart.prototype.setTimeRange = function(startTime, endTime) {
    /**
     * Alter the time range of this chart and redraw
     *
     * @param startTime: The start time I{Date}
     * @param endTime: The end time I{Date}
     **/
    this.startTime = startTime;
    this.endTime = endTime;
    return this.draw();
}

jrrd.Chart.prototype.draw = function() {
    /**
     * Draw the chart
     * A 'chart_loading' event is triggered before the data is requested
     * A 'chart_loaded' event is triggered when the chart has been drawn
     *
     * @return: A I{MochiKit.Async.Deferred} which calls back with the chart
     *          data when the chart has been rendered.
     **/
    this.template.trigger('chart_loading');
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
                    [this.startTime.getTime(), 0],
                    [this.endTime.getTime(), 0]
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

                    $.plot(self.template, data, self.options);

                    // Highlight any disabled data sources in the legend
                    self.template.find('.legendLabel').each(
                        function(i, el) {
                            var labelCell = $(el);
                            if( $.inArray(labelCell.text(), disabled) > -1 ) {
                                labelCell.addClass('disabled');
                            }
                        }
                    );
                    var yaxisUnitLabel = $('<div>').text(self.siPrefix + unit)
                                                   .css({width: '100px',
                                                         position: 'absolute',
                                                         top: '80px',
                                                         left: '-90px',
                                                         'text-align': 'right'});
                    self.template.append(yaxisUnitLabel);
                    yaxisUnitLabel.position(self.template.position());
                    return data;
                }, this)
            .addErrback(
                function(self, failure) {
                    self.template.text('error: ' + failure.message);
                }, this)
            .addBoth(
                function(self, res) {
                    self.template.trigger('chart_loaded');
                    return res;
                }, this);
};


// Options common to all the chart on this page
jrrd.Chart.BASE_OPTIONS = {
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
        noColumns: 2
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
        mode: "time"
    }
};

// Extra options to generate a stacked chart
jrrd.Chart.STACKED_OPTIONS = {
    series: {
        stack: true,
        lines: {
            fill: 0.5
        }
    }
};

jrrd.COLLECTD_RECIPES = {
    'cpu': [
        {
            title: 'CPU Usage',
            data: [
                ['cpu-0/cpu-wait.rrd', 0, 'CPU-0 Wait', 'Jiffies'],
                ['cpu-1/cpu-wait.rrd', 0, 'CPU-1 Wait', 'Jiffies'],
                ['cpu-0/cpu-system.rrd', 0, 'CPU-0 System', 'Jiffies'],
                ['cpu-1/cpu-system.rrd', 0, 'CPU-1 System', 'Jiffies'],
                ['cpu-0/cpu-user.rrd', 0, 'CPU-0 User', 'Jiffies'],
                ['cpu-1/cpu-user.rrd', 0, 'CPU-1 User', 'Jiffies']
            ],
            options: jQuery.extend(true, {}, jrrd.Chart.BASE_OPTIONS,
                                             jrrd.Chart.STACKED_OPTIONS)
        },
    ],

    'memory': [
        {
            title: 'Memory',
            data: [
                ['memory/memory-buffered.rrd', 0, 'Buffered', 'B'],
                ['memory/memory-used.rrd', 0, 'Used', 'B'],
                ['memory/memory-cached.rrd', 0, 'Cached', 'B'],
                ['memory/memory-free.rrd', 0, 'Free', 'B']
            ],
            options: jQuery.extend(true, {}, jrrd.Chart.BASE_OPTIONS,
                                             jrrd.Chart.STACKED_OPTIONS)
        }
    ],

    'dns': [
        {
            title: 'DNS Query Types',
            data: [
                ['dns/dns_qtype-A.rrd', 0, 'A', 'Q/sec'],
                ['dns/dns_qtype-PTR.rrd', 0, 'PTR', 'Q/sec'],
                ['dns/dns_qtype-SOA.rrd', 0, 'SOA', 'Q/sec'],
                ['dns/dns_qtype-SRV.rrd', 0, 'SRV', 'Q/sec']
            ],
            options: jQuery.extend(true, {}, jrrd.Chart.BASE_OPTIONS)
        },

        {
            title: 'DNS Return Codes',
            data: [
                ['dns/dns_rcode-NOERROR.rrd', 0, 'NOERROR', 'Q/sec'],
                ['dns/dns_rcode-NXDOMAIN.rrd', 0, 'NXDOMAIN', 'Q/sec'],
                ['dns/dns_rcode-SERVFAIL.rrd', 0, 'SERVFAIL', 'Q/sec']
            ],
            options: jQuery.extend(true, {}, jrrd.Chart.BASE_OPTIONS)
        }
    ],

    'load': [
        {
            title: 'Load Average',
            data: [
                ['load/load.rrd', 'shortterm', 'Short Term', ''],
                ['load/load.rrd', 'midterm', 'Medium Term', ''],
                ['load/load.rrd', 'longterm', 'Long Term', '']
            ],
            options: jQuery.extend(true, {}, jrrd.Chart.BASE_OPTIONS)
        }
    ],

    'interface': [
        {
            title: 'Wlan0 Throughput',
            data: [
                ['interface/if_octets-wlan0.rrd', 'tx', 'Transmit', 'b/sec'],
                ['interface/if_octets-wlan0.rrd', 'rx', 'Receive', 'b/sec']
            ],
            options: jQuery.extend(true, {}, jrrd.Chart.BASE_OPTIONS)
        }
    ]
};

jrrd.collectdChartFactory = function(rrdUrlList, recipes, templateFactory) {
    /**
     * A factory function to generate a list of I{Chart} from a list of recipes
     * and a list of available rrd files in collectd path format.
     *
     * @param rrdUrlList: A list of rrd download paths
     * @param recipes: A list of recipe objects
     * @param templateFactory: A callable which generates an html template for a
     *      chart.
     **/
    var rrdUrlBlob = rrdUrlList.join('\n')

    var charts = [];
    var dataDict = {};

    var recipe, chartData, template, c, i, j, x, ds, label, rrd, unit, re, match;

    for(i=0; i<recipes.length; i++) {
        recipe = recipes[i];
        chartData = [];

        for(j=0; j<recipe['data'].length; j++) {
            rrd = recipe['data'][j][0];
            ds = recipe['data'][j][1];
            label = recipe['data'][j][2];
            unit = recipe['data'][j][3];
            re = new RegExp('.*/' + rrd, 'gm');
            match = rrdUrlBlob.match(re);
            if(!match) {
                continue;
            }
            for(x=0; x<match.length; x++) {

                if(typeof dataDict[match[x]] == 'undefined') {
                    dataDict[match[x]] = new jrrd.RrdQueryRemote(match[x], unit);
                }
                chartData.push([label, new jrrd.RrdQueryDsProxy(dataDict[match[x]], ds)]);
            }
        }
        if(chartData.length > 0) {
            template = templateFactory();
            template.find('.title').text(recipe['title']);
            c = new jrrd.Chart(template.find('.chart'), recipe['options']);
            for(j=0; j<chartData.length; j++) {
                c.addData.apply(c, chartData[j]);
            }
            charts.push(c);
        }
    }
    return charts;
}


/**
 * Presents the user with a form and a timeline with which they can choose a
 * time range and co-ordinates the refreshing of a series of charts.
 *
 * @param ui: A one element I{jQuery} containing an input form and placeholders
 *            for the timeline and for the series of charts.
 **/
jrrd.ChartCoordinator = function(ui) {
    this.ui = ui;
    this.charts = [];

    var self = this;

    // Update the time ranges and redraw charts when the form is submitted
    this.ui.bind('submit', function(e) {
        self.update();
        return false;
    });

    // Reset all the charts to the default time range when the reset button is
    // pressed.
    this.ui.bind('reset', function(e) {
        self.reset();
        return false;
    });

    // Style and configuration of the range timeline
    this.rangePreviewOptions = {
        grid: {
            borderWidth: 1
        },
        selection: {
            mode: 'x'
        },
        xaxis: {
            mode: "time"
        },
        yaxis: {
            ticks: []
        }
    };

    // When a selection is made on the range timeline, redraw all the charts.
    this.ui.bind("plotselected", function(event, ranges) {
        self.setTimeRange(new Date(ranges.xaxis.from),
                          new Date(ranges.xaxis.to));
    });
};

jrrd.ChartCoordinator.prototype.update = function() {
    /**
     * Grab the start and end time from the ui form, highlight the range on the
     * range timeline and set the time range of all the charts and redraw.
     **/
    var startTime = new Date(this.ui[0].startTime.value);
    var endTime = new Date(this.ui[0].endTime.value);
    var chartsLoading = [];
    for(var i=0; i<this.charts.length; i++){
        chartsLoading.push(
            this.charts[i].setTimeRange(startTime, endTime));
    }
    MochiKit.Async.gatherResults(chartsLoading).addCallback(
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
                    from: Math.max(startTime.getTime(), firstUpdate),
                    to: Math.min(endTime.getTime(), lastUpdate)
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

jrrd.ChartCoordinator.prototype.setTimeRange = function(startTime, endTime) {
    /**
     * Set the start and end time fields in the form and trigger an update
     *
     * @param startTime: The start time I{Date}
     * @param endTime: The end time I{Date}
     **/
    this.ui[0].startTime.value = startTime.toString().split(' ').slice(1,5).join(' ');
    this.ui[0].endTime.value = endTime.toString().split(' ').slice(1,5).join(' ');
    this.update();
};

jrrd.ChartCoordinator.prototype.reset = function() {
    /**
     * Reset all charts and the input form to the default time range - last hour
     **/
    this.setTimeRange(new Date(new Date().getTime()-1*60*60*1000),
                      new Date());
};

