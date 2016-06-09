Ext.define("TSDependencyByPI", {
    extend: 'Rally.app.App',
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),
    defaults: { margin: 10 },
    
    stories: [],
    
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
        
        TSUtilities.fetchPortfolioItemTypes().then({
            scope: this,
            success: function(results) {
                this.pi_types = results;
                this._updateData();
            }
        });
    },

    _updateData: function() {
        var me = this;
        this.stories = [];
        this.down('#display_box').removeAll();
        
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
            fetch: ['ObjectID','FormattedID','Name','Predecessors','Successors','Iteration','ScheduleState','Blocked',
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
        
//        this._getHierarchyListFromLookback(stories_by_oid).then({
//            success:function(results) {
//                console.log('--', results);
//                //return stories;
//            },
//            failure: function(msg) {
//                deferred.reject(msg);
//            }
//        });
        
        
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
            fetch: ['FormattedID', 'Name', 'ScheduleState','Iteration','Blocked',
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
            fetch: ['FormattedID', 'Name', 'ScheduleState','Iteration','Blocked',
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
        var iteration = iteration_object.iteration;
        var stories = iteration_object.stories;
        
        var box = container.add({
            xtype:'container',
            border: 1,
            style: {borderColor:'#000000', borderStyle:'solid', borderWidth:'1px'},
            padding: 5,
            margin: 10,
            width: 300,
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
            html: Ext.String.format("<span class='iteration-header'>{0}</span><br/>{1}<hr/>",
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
                hierarchy_string = Ext.String.format("{0}: {1}",
                    story.get(level).FormattedID,
                    story.get(level).Name
                );
            }
            
            var level = "__Grandparent";
            if ( story.get(level) ) {
                hierarchy_string = hierarchy_string + " > " + Ext.String.format("{0}: {1}",
                    story.get(level).FormattedID,
                    story.get(level).Name
                );
            }
            
            var level = "__Greatgrandparent";
            if ( story.get(level) ) {
                hierarchy_string = hierarchy_string + " > " + Ext.String.format("{0}: {1}",
                    story.get(level).FormattedID,
                    story.get(level).Name
                );
            }
            
            summary.add({
                xtype:'container',
                cls: 'story-header',
                html: Ext.String.format("{0}<br/>{1}: {2}<br/>{3}",
                    story.get('Project')._refObjectName,
                    story.get('FormattedID'),
                    story.get("_refObjectName"),
                    hierarchy_string
                )
            });
            
            Ext.Array.each(story.get('__Predecessors'), function(predecessor){
                
                var schedule_state_box = Ext.String.format("<div class='state-legend'>{0}</div>",
                    predecessor.get('ScheduleState').charAt(0)
                );
                
                var status_message = "<img src='/slm/images/icon_alert_sm.gif' alt='Warning' title='Warning'> Not yet scheduled";
                
                if ( !Ext.isEmpty(predecessor.get('Iteration') ) ) {
                    var story_end = iteration.EndDate;
                    var dependency_end = predecessor.get('Iteration').EndDate;
                    
                    if ( dependency_end >= story_end && !Ext.isEmpty(story_end) ) {
                        status_message = "<img src='/slm/images/icon_alert_sm.gif' alt='Warning' title='Warning'>  Scheduled for " + dependency_end.replace(/T.*$/,'');
                    } else { 
                        status_message = "Scheduled for " + dependency_end.replace(/T.*$/,'');
                    }
                    
                }
                                    
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 10',
                    html: Ext.String.format('{0} Waiting on <b>{1}</b> for <br/>{2}:{3}',
                        schedule_state_box,
                        predecessor.get('Project')._refObjectName,
                        predecessor.get('FormattedID'),
                        predecessor.get('Name')
                    )
                });
                
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 30',
                    html: status_message
                });
                
            });

            if ( !Ext.isEmpty(story.get("__Predecessors")) && story.get("__Predecessors").length > 0 &&
                !Ext.isEmpty(story.get("__Successors")) && story.get("__Successors").length > 0  ) {
                    summary.add({ xtype:'container', html: "<hr/>" });
            }

            Ext.Array.each(story.get('__Successors'), function(successor){
                                
                var schedule_state_box = Ext.String.format("<div class='state-legend'>{0}</div>",
                    successor.get('ScheduleState').charAt(0)
                );
                
                var status_message = "<img src='/slm/images/icon_alert_sm.gif' alt='Warning' title='Warning'> Not yet scheduled";
                
                if ( !Ext.isEmpty(successor.get('Iteration') ) ) {
                    var story_end = iteration.EndDate;
                    var dependency_end = successor.get('Iteration').EndDate;
                    
                    if ( dependency_end >= story_end && !Ext.isEmpty(story_end) ) {
                        status_message = "<img src='/slm/images/icon_alert_sm.gif' alt='Warning' title='Warning'>  Scheduled for " + dependency_end.replace(/T.*$/,'');
                    } else { 
                        status_message = "Scheduled for " + dependency_end.replace(/T.*$/,'');
                    }
                    
                }
                                    
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 10',
                    html: Ext.String.format('{0} Needed by <b>{1}</b> for <br/>{2}:{3}',
                        schedule_state_box,
                        successor.get('Project')._refObjectName,
                        successor.get('FormattedID'),
                        successor.get('Name')
                    )
                });
                
                summary.add({
                    xtype:'container',
                    margin: '2 2 5 30',
                    html: status_message
                });
                
            });
            
        });
            
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
    
    getOptions: function() {
        return [
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
