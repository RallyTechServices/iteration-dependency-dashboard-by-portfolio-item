Ext.define("TSDependencyByPI", {
    extend: 'Rally.app.App',
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),
    defaults: { margin: 10 },
    
    stories: [],
    allowedStates: [],
    rows: [],
    
    
    items: [
        {xtype:'container',itemId:'display_box', overflowY: 'auto', layout: 'column'}
    ],

    integrationHeaders : {
        name : "TSDependencyByPI"
    },
    
    config: {
        defaultSettings: {
            parentRecordType: null,
            parentQuery: '( ObjectID > 0 )'
        }
    },
    
    launch: function() {
        var me = this;
        if ( Ext.isEmpty( this.getSetting('parentRecordType') ) || Ext.isEmpty( this.getSetting('parentQuery') ) ) {
            Ext.Msg.alert("","Please use the Edit App Settings gear menu item to choose an ancestor record type and query");
            return;
        }
        
        this.setLoading("Fetching base information...");
        
        TSUtilities.fetchFieldValues('HierarchicalRequirement','ScheduleState').then({
            scope: this,
            success: function(states) {
                this.allowedStates = states;
                this.logger.log("Allowed States: ", this.allowedStates);
                
                TSUtilities.fetchPortfolioItemTypes().then({
                    scope: this,
                    success: function(results) {
                        this.pi_types = results;
                        this._updateData();
                    }
                });
            }
        }).always(function() { me.setLoading(false); });
        
    },

    _updateData: function() {
        var me = this;
        this.stories = [];
        this.down('#display_box').removeAll();
        
        this.setLoading("Fetching data...");

        Deft.Chain.pipeline([
            me._getPortfolioItems,
            me._getDescendantStoriesWithDependencies,
            me._getAscendantPIs
        ],this).then({
            scope: this,
            success: function(stories){
                
                var iterations = this._collectByIteration(stories);
                
                this._makeIterationBoxes(iterations);
            },
            failure: function(msg) {
                Ext.Msg.alert('',msg);
            }
        }).always(function() { me.setLoading(false); });
    },
    
    _getPortfolioItems: function() {
        this.setLoading('Fetching items that match the query...');
        
        var filters = Rally.data.wsapi.Filter.fromQueryString(this.getSetting('parentQuery'));
        var model = this._getPITypePathFromTypeDef(this.getSetting('parentRecordType'));
                
        var config = {
            model: model,
            filters: filters,
            fetch: ['ObjectID','FormattedID']
        };
        
        return TSUtilities.loadWsapiRecords(config);
        
    },
    
    _getDescendantStoriesWithDependencies: function(portfolio_items) {
        this.setLoading('Fetching stories...');

        if ( portfolio_items.length === 0 ) {
            this.down('#display_box').add({xtype:'container',html:'No items found'});
            return;
        }
        var me = this,
            deferred = Ext.create('Deft.Deferred'),
            ascendant_ordinal = null,
            oid = TSUtilities.getOidFromRef(this.getSetting('parentRecordType'));
       
        Ext.Array.each(this.pi_types, function(pi_type){
            if ( "" + pi_type.get('ObjectID') == "" + oid ) {
                ascendant_ordinal = pi_type.get('Ordinal');
            }
        });
                
        var lowest_level_pi_name = this.pi_types[0].get('Name');
        var field_prefix = lowest_level_pi_name;

        for ( var i=1; i<=ascendant_ordinal; i++ ) {
            field_prefix = field_prefix + ".Parent";
        }
        
        var pi_filter_array = Ext.Array.map(portfolio_items, function(pi){
            return { property:field_prefix + '.ObjectID',value:pi.get('ObjectID') };
        });
        
        var pi_filters = Rally.data.wsapi.Filter.or(pi_filter_array);
        var dependency_filter = Rally.data.wsapi.Filter.or([
            { property:'Predecessors.ObjectID',operator:'>',value:0 },
            { property:'Successors.ObjectID',operator:'>',value:0 }
        ]);
        
        var filters = dependency_filter.and(pi_filters);
        
        var config = {
            model: 'UserStory',
            fetch: ['ObjectID','FormattedID','Name','Predecessors','Successors','Iteration','ScheduleState','ScheduleStatePrefix','Blocked',
                'StartDate', 'EndDate', 'Project',lowest_level_pi_name,'Parent'],
            filters: filters,
            limit: Infinity,
            context: {
                project: null
            }
        };
        
        TSUtilities.loadWsapiRecords(config).then({
            scope: this,
            success: function(stories) {
                if ( stories.length === 0 ) {
                    deferred.resolve([]);
                    return;
                }
                
                this.setLoading('Fetching dependency information...');
                
                var promises = [];
                
                Ext.Array.each(stories, function(story){
                    promises.push(function() { return me._fetchPredecessorsFor(story); });
                    promises.push(function() { return me._fetchSuccessorsFor(story); });
                }, me);
                
                Deft.Chain.sequence(promises).then({
                    success: function(results) {
                        deferred.resolve( Ext.Array.unique(stories) );
                    },
                    failure: function(msg) {
                        deferred.reject(msg);
                    }
                }).always(function(){ me.setLoading(false); });
                
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        
        return deferred.promise;
        
    },
    
    _getAscendantPIs: function(stories) {
        this.logger.log('_getAscendantPIs',stories);
        var deferred = Ext.create('Deft.Deferred');
        
        if ( Ext.isEmpty(stories) || stories.length === 0 ) {
            return stories;
        }
        this.setLoading('Fetch Hierarchy...');
        
        var stories_by_oid = {};
        Ext.Array.each(stories, function(story){
            stories_by_oid[parseInt(story.get('ObjectID'),10)] = story;
        });
        
        //lookback isn't working tonight
        var lowest_level_pi_name = this.pi_types[0].get('Name');
        var grandparent_filters = Ext.Array.map(stories, function(story){
            var parent = story.get(lowest_level_pi_name).Parent;
            story.set('__Parent', story.get(lowest_level_pi_name));
            
            if ( parent ) {
                story.set('__Grandparent',parent);
                return {property:'ObjectID',value:parent.ObjectID};
            }
            return {property:'ObjectID',value:-1};
        });
        
        var unique_grandparent_filters = Ext.Array.unique(grandparent_filters);
        
        var filters = Rally.data.wsapi.Filter.or(unique_grandparent_filters);
        
        var config = {
            model: this.pi_types[1].get('TypePath'),
            limit: Infinity,
            filters: filters,
            fetch: ['FormattedID','Name','Parent']
        };
        
        TSUtilities.loadWsapiRecords(config).then({
            success: function(grandparents) {
                console.log('grandparents', grandparents);
                var grandparents_by_oid = {};
                Ext.Array.each(grandparents, function(grandparent){
                    grandparents_by_oid[grandparent.get('ObjectID')] = grandparent;
                });
                
                Ext.Array.each(stories, function(story){
                    var grandparent = story.get('__Grandparent');
                    if ( grandparent ) {
                        var grandparent_oid = grandparent.ObjectID;
                        if (grandparents_by_oid[grandparent_oid] && grandparents_by_oid[grandparent_oid].get('Parent')) {
                            story.set('__Greatgrandparent',grandparents_by_oid[grandparent_oid].get('Parent'));
                        }
                    }
                });
                
                deferred.resolve(stories);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        
        return deferred.promise;
    },
    
    _getHierarchyListFromLookback: function(stories_by_oid) {
        var deferred = Ext.create('Deft.Deferred');
        oids = Ext.Object.getKeys(stories_by_oid);
        
        var config = {
            fetch: ['_ItemHierarchy','ObjectID'],
            filters: [
                {property:'ObjectID',operator:'in',value:oids},
                {property:'__At',value:'current'}
            ]
        };
        
        console.log(config);
        
//        TSUtilities.loadLookbackRecords().then({
//            success: function(snapshots){
//                Ext.Array.each(snapshots, function(snapshot){
//                    var oid = snapshot.get('ObjectID');
//                    stories_by_oid[oid].set('_ItemHierarchy', snapshot.get('_ItemHierarchy'));
//                });
//                
//                deferred.resolve(stories_by_oid);
//            },
//            failure: function(msg) {
//                deferred.reject(msg);
//            }
//            
//        });
        
        return deferred.promise;
    },
    
    _fetchPredecessorsFor: function(story) {
        var deferred = Ext.create('Deft.Deferred');
        
        story.getCollection('Predecessors').load({
            fetch: ['FormattedID', 'Name', 'ScheduleState','ScheduleStatePrefix','Iteration','Blocked',
                'StartDate','EndDate','Project'],
            callback: function(records, operation, success) {
                story.set('__Predecessors', records);
                deferred.resolve(story);
            }
        });

        return deferred.promise;
    },
    
    _fetchSuccessorsFor: function(story) {
        var deferred = Ext.create('Deft.Deferred');

        story.getCollection('Successors').load({
            fetch: ['FormattedID', 'Name', 'ScheduleState','ScheduleStatePrefix','Iteration','Blocked',
                'StartDate','EndDate','Project'],
            callback: function(records, operation, success) {
                story.set('__Successors', records);
                deferred.resolve(story);
            }
        });

        return deferred.promise;
    },
    
    _collectByIteration: function(stories) {
        var stories_by_iteration = {};
        Ext.Array.each(stories, function(story){
            
            var iteration = story.get('Iteration') || { 
                StartDate: null,
                EndDate: null,
                Name: "Unscheduled"
            };
            
            var iteration_start = iteration.StartDate;
            if ( Ext.isEmpty(stories_by_iteration[iteration_start]) ) {
                stories_by_iteration[iteration_start] = {
                    iteration: iteration,
                    stories: []
                };
            }
            
            stories_by_iteration[iteration_start].stories.push(story);
        });
        
        return stories_by_iteration;
    },
    
    _makeIterationBoxes: function(iterations) {
        this.logger.log('iterations', iterations);
        var container = this.down('#display_box');
        
        var iteration_dates_in_order = Ext.Object.getKeys(iterations).sort();
        
        Ext.Array.each(iteration_dates_in_order, function(iteration_date) {
            var iteration_object = iterations[iteration_date];
            this._addIterationBox(container,iteration_object);
        },this);
        
    },
    
    _addIterationBox: function(container,iteration_object) {
        var me = this;
        var iteration = iteration_object.iteration;
        var stories = iteration_object.stories;
        
        var box = container.add({
            xtype:'container',
            border: 1,
            style: {borderColor:'#000000', borderStyle:'solid', borderWidth:'1px'},
            padding: 5,
            margin: 10,
            width: 525,
            height: 400,
            overflowY: 'auto'
        });
        
        var iteration_start = iteration.StartDate || "--";
        var iteration_end = iteration.EndDate || "--";
        
        var iteration_date_string = Ext.String.format("{0} to {1}",
            iteration_start.replace(/T.*$/,''),
            iteration_end.replace(/T.*$/,'')
        );
        
        if ( iteration_start == "--" ) {
            iteration_date_string = "--";
        }
        
        var header = box.add({
            xtype:'container',
            html: Ext.String.format("<span class='iteration-header'>{0}</span><br/>{1}",
                iteration.Name,
                iteration_date_string
            )
        });
        
        var summary = box.add({
            xtype:'container'
        });
        
        Ext.Array.each(stories, function(story){
            var hierarchy_string = "";
            
            var level = "__Parent";
            if ( story.get(level) ) {
                hierarchy_string = Ext.String.format("<a href='{0}' target='_top'>{1}</a>: {2}",
                    Rally.nav.Manager.getDetailUrl(story.get(level)),
                    story.get(level).FormattedID,
                    story.get(level).Name
                );
            }
            
            var level = "__Grandparent";
            if ( story.get(level) ) {
                hierarchy_string = hierarchy_string + " <br/> " + Ext.String.format("<a href='{0}' target='_top'>{1}</a>: {2}",
                    Rally.nav.Manager.getDetailUrl(story.get(level)),
                    story.get(level).FormattedID,
                    story.get(level).Name
                );
            }
            
            var level = "__Greatgrandparent";
            if ( story.get(level) ) {
                hierarchy_string = hierarchy_string + " <br/> " + Ext.String.format("<a href='{0}' target='_top'>{1}</a>: {2}",
                    Rally.nav.Manager.getDetailUrl(story.get(level)),
                    story.get(level).FormattedID,
                    story.get(level).Name
                );
            }
            
            var state_string = story.get('ScheduleState');
            
            summary.add({
                xtype:'container',
                cls: 'story-header',
                html: Ext.String.format("<hr/>{0}<br/><a href='{1}' target='_top'>{2}</a>: {3} ({4})<br/><div style='padding: 1px 1px 1px 10px'>{5}</div>",
                    story.get('Project')._refObjectName,
                    Rally.nav.Manager.getDetailUrl(story),
                    story.get('FormattedID'),
                    story.get("_refObjectName"),
                    state_string,
                    hierarchy_string
                )
            });
            
            
            Ext.Array.each(story.get('__Predecessors'), function(predecessor){
                
                var schedule_state = predecessor.get('ScheduleState');
                var state_color = 'state-legend-red';
                if ( schedule_state == 'Completed' || schedule_state == 'In-Progress' ) {
                    state_color = 'state-legend-yellow';
                }
                
                if ( me._isAccepted(predecessor) ) {
                    state_color = 'state-legend-green';
                }
                
                var schedule_state_box = Ext.String.format("<div class='state-legend {0}'>{1}</div>",
                    state_color,
                    predecessor.get('ScheduleStatePrefix')
                );
                
                var status_flag = true;
                var status_message = "Not yet scheduled";
               
                if ( !Ext.isEmpty(predecessor.get('Iteration') ) ) {
                    var story_end = iteration.EndDate;
                    var dependency_end = predecessor.get('Iteration').EndDate;

                    status_message = "Scheduled for " + predecessor.get('Iteration')._refObjectName;
                    
                    if ( dependency_end >= story_end && !Ext.isEmpty(story_end) ) {
                        status_flag = true;
                    } else { 
                        status_flag = false;
                    }
                    
                }
                
                if ( me._isAccepted(predecessor) ) {
                    status_flag = false;
                }
                
                if ( status_flag ) {
                    var warning_flag = "<img src='/slm/images/icon_alert_sm.gif' alt='Warning' title='Warning'>";
                    status_message = warning_flag + " " + status_message;
                }
                
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 10',
                    html: Ext.String.format("Waiting on <b>{0}</b> for <br/>{1} <a href='{2}' target='_top'>{3}</a>:{4}",
                        predecessor.get('Project')._refObjectName,
                        schedule_state_box,
                        Rally.nav.Manager.getDetailUrl(predecessor),
                        predecessor.get('FormattedID'),
                        predecessor.get('Name')
                    )
                });
                
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 30',
                    html: status_message
                });
                
                me.rows.push({
                    Iteration: iteration,
                    Story: story,
                    Type: 'Waiting on',
                    Target: predecessor
                });
                
            });

            if ( !Ext.isEmpty(story.get("__Predecessors")) && story.get("__Predecessors").length > 0 &&
                !Ext.isEmpty(story.get("__Successors")) && story.get("__Successors").length > 0  ) {
                    summary.add({ xtype:'container', html: "<hr style='border-top: 1px dotted #8c8b8b;'/>" });
            }

            Ext.Array.each(story.get('__Successors'), function(successor){
                
                var schedule_state = successor.get('ScheduleState');
                var state_color = 'state-legend-red';
                if ( schedule_state == 'Completed' || schedule_state == 'In-Progress' ) {
                    state_color = 'state-legend-yellow';
                }
                
                if ( me._isAccepted(successor) ) {
                    state_color = 'state-legend-green';
                }
                
                var schedule_state_box = Ext.String.format("<div class='state-legend {0}'>{1}</div>",
                    state_color,
                    successor.get('ScheduleStatePrefix')
                );
                
                var status_flag = true;
                var status_message = "Not yet scheduled"; 
                
                if ( !Ext.isEmpty(successor.get('Iteration') ) ) {
                    var story_end = iteration.EndDate;
                    var dependency_end = successor.get('Iteration').EndDate;
                                        
                    status_message = "Scheduled for " + successor.get('Iteration')._refObjectName;

                    if ( dependency_end >= story_end && !Ext.isEmpty(story_end) ) {
                        status_flag = true;
                    } else { 
                        status_flag = false;
                    }
                    
                }
               
                if ( me._isAccepted(successor) ) {
                    status_flag = false;
                }
                
                if ( status_flag ) {
                    var warning_flag = "<img src='/slm/images/icon_alert_sm.gif' alt='Warning' title='Warning'>";
                    status_message = warning_flag + " " + status_message;
                }
                
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 10',
                    html: Ext.String.format("Needed by <b>{0}</b> for <br/>{1} <a href='{2}' target='_top'>{3}</a>:{4}",
                        successor.get('Project')._refObjectName,
                        schedule_state_box,
                        Rally.nav.Manager.getDetailUrl(successor),
                        successor.get('FormattedID'),
                        successor.get('Name')
                    )
                });
                
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 30',
                    html: status_message
                });
                
                
                me.rows.push({
                    Iteration: iteration,
                    Story: story,
                    Type: 'Needed by',
                    Target: successor
                });
                
            });
            
        });
            
    },
    
    _isAccepted: function(item) {
        return (Ext.Array.indexOf(this.allowedStates,'Accepted') <= Ext.Array.indexOf(this.allowedStates,item.get('ScheduleState')) );
    },
    
    /*
     * type def looks like "/typedefinition/1324342"
     */
    _getPITypePathFromTypeDef: function(typedef) {
        var oid = TSUtilities.getOidFromRef(typedef);
        
        var model = "PortfolioItem";
        Ext.Array.each(this.pi_types, function(type){
            if ( "" + type.get('ObjectID') == "" + oid ) {
                model = type.get('TypePath');
            }
        });
        return model;
    },
    
    _getExportColumns: function() {
        return [
            {
                dataIndex: 'Iteration',
                text: 'Iteration',
                renderer: function(value,meta,record) { 
                    if ( Ext.isEmpty(value) || Ext.isEmpty(value._refObjectName) ) { return "Unscheduled"; }
                    return value._refObjectName;
                }
            },
            { 
                dataIndex: 'Story',
                text: 'Story ID',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    return value.get('FormattedID');
                }
            },
            { 
                dataIndex: 'Story',
                text: 'Story Name',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    return value.get('Name');
                }
            },
            { 
                dataIndex: 'Story',
                text: 'Schedule State',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    return value.get('ScheduleState');
                }
            },
            { 
                dataIndex: 'Story',
                text: 'Team',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    var iteration = value.get('Project');
                    if ( Ext.isEmpty(iteration) || Ext.isEmpty(iteration._refObjectName) ) { return ""; }
                    return value.get('Project')._refObjectName;
                }
            },
            { 
                dataIndex: 'Type',
                text: 'Direction'
            },
            { 
                dataIndex: 'Target',
                text: 'Target Story ID',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    return value.get('FormattedID');
                }
            },
            { 
                dataIndex: 'Target',
                text: 'Target Story Name',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    return value.get('Name');
                }
            },
            { 
                dataIndex: 'Target',
                text: 'Target Schedule State',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    console.log('...', record);
                    return value.get('ScheduleState');
                }
            },
            { 
                dataIndex: 'Target',
                text: 'Target Iteration',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return "Unscheduled"; }
                    var iteration = value.get('Iteration');
                    if ( Ext.isEmpty(iteration) || Ext.isEmpty(iteration._refObjectName) ) { return "Unscheduled"; }
                    return value.get('Iteration')._refObjectName;
                }
            },
            { 
                dataIndex: 'Target',
                text: 'Target Team',
                renderer: function(value, meta, record) {
                    if ( Ext.isEmpty(value) || !Ext.isFunction(value.get) ) { return ""; }
                    var iteration = value.get('Project');
                    if ( Ext.isEmpty(iteration) || Ext.isEmpty(iteration._refObjectName) ) { return ""; }
                    return value.get('Project')._refObjectName;
                }
            }
        ];
    },
    
    _export: function(){
        var me = this;
        this.logger.log('_export');
        
        var rows = this.rows;
        
        var grid = Ext.create('Rally.ui.grid.Grid',{
            store: Ext.create('Rally.data.custom.Store',{ data: rows}),
            columnCfgs: this._getExportColumns()
        });
        
        this.logger.log('rows:', rows.length, rows);
        
        var filename = 'dependency-report.csv';

        this.logger.log('saving file:', filename);
        
        this.setLoading("Generating CSV");
        Deft.Chain.sequence([
            function() { return Rally.technicalservices.FileUtilities.getCSVFromRows(this,grid,rows); } 
        ]).then({
            scope: this,
            success: function(csv){
                this.logger.log('got back csv ', csv.length);
                if (csv && csv.length > 0){
                    Rally.technicalservices.FileUtilities.saveCSVToFile(csv,filename);
                } else {
                    Rally.ui.notify.Notifier.showWarning({message: 'No data to export'});
                }
                
            }
        }).always(function() { me.setLoading(false); });
    },
    
    getOptions: function() {
        return [
            { 
                text: 'Export',
                handler: this._export,
                scope: this
            },
            {
                text: 'About...',
                handler: this._launchInfo,
                scope: this
            }
        ];
    },
    
    _launchInfo: function() {
        if ( this.about_dialog ) { this.about_dialog.destroy(); }
        this.about_dialog = Ext.create('Rally.technicalservices.InfoLink',{});
    },
    
    isExternal: function(){
        return typeof(this.getAppId()) == 'undefined';
    },
    
    getSettingsFields: function() {
        return Rally.technicalservices.dependency.Settings.getFields();
    }
});
