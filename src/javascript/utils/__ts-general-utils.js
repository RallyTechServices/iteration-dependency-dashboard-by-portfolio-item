Ext.define('TSUtilities', {
    singleton: true,
    
    loadLookbackRecords: function(config){
        var me = this,
            deferred = Ext.create('Deft.Deferred');

        var default_config = {
            fetch: ['ObjectID']
        };
        Ext.create('Rally.data.lookback.SnapshotStore', Ext.Object.merge(default_config,config)).load({
            callback : function(records, operation, successful) {
                if (successful){
                    deferred.resolve(records);
                } else {
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    loadWsapiRecords: function(config,returnOperation){
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        var default_config = {
            model: 'Defect',
            fetch: ['ObjectID'],
            compact: false
        };
        Ext.create('Rally.data.wsapi.Store', Ext.Object.merge(default_config,config)).load({
            callback : function(records, operation, successful) {
                if (successful){
                    if ( returnOperation ) {
                        deferred.resolve(operation);
                    } else {
                        deferred.resolve(records);
                    }
                } else {
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    loadWsapiRecordsWithParallelPages: function(config) {
        var deferred = Ext.create('Deft.Deferred'),
            me = this;
        
        var count_check_config = Ext.clone(config);
        count_check_config.limit = 1;
        count_check_config.pageSize = 1;
        
        this.loadWsapiRecords(count_check_config, true).then({
            success: function(operation) {
                
                config.pageSize = 200;
                config.limit = config.pageSize;
                var total = operation.resultSet.totalRecords;
                var page_count = Math.ceil(total/config.pageSize);
                    
                var promises = [];
                Ext.Array.each(_.range(1,page_count+1), function(page_index) {
                    var config_clone = Ext.clone(config);
                    config_clone.currentPage = page_index;
                    promises.push(function() {
                        var percentage = parseInt( page_index * 100 / page_count, 10);
                        Rally.getApp().setLoading("Loading time values (" + percentage + "%)");
                        return me.loadWsapiRecords(config_clone); 
                    });
                });
                CA.techservices.promise.ParallelThrottle.throttle(promises, 6, me).then({
                        success: function(results){
                            deferred.resolve( Ext.Array.flatten(results) );
                        },
                        failure: function(msg) {
                            deferred.reject(msg);
                        }
                });
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        return deferred.promise;
    },
    
    getOidFromRef: function(ref) {
        var ref_array = ref.replace(/\.js$/,'').split(/\//);
        return ref_array[ref_array.length-1];
    },
    
    fetchFieldValues: function(record_type, field_name) {
        var deferred = Ext.create('Deft.Deferred');
        Rally.data.ModelFactory.getModel({
            type: record_type,
            success: function(model) {
                model.getField(field_name).getAllowedValueStore().load({
                    callback: function(allowed_values, operation, success) {
                        deferred.resolve(Ext.Array.map(allowed_values, function(allowed_value){
                            return allowed_value.get('StringValue');
                        }));
                    }
                });
            }
        });
        return deferred.promise;
    },
    
    fetchPortfolioItemTypes: function() {
        var config = {
            model: 'TypeDefinition', 
            fetch: ["TypePath","Ordinal","Name"],
            filters: [{property:'TypePath', operator:'contains', value:'PortfolioItem/'}],
            sorters: [{property:'Ordinal',direction:'ASC'}]
        };
        
        return TSUtilities.loadWsapiRecords(config);
    }
    
});