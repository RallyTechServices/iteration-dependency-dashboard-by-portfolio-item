Ext.define('Rally.technicalservices.dependency.Settings', {
    singleton: true,

    getFields: function(config) {
        
        var items = [];
        
        items.push({
            name: 'parentRecordType',
            xtype: 'rallyportfolioitemtypecombobox',
            margin: '10px 0 0 0',
            fieldLabel: 'Record Type for Query',
            readyEvent: 'ready' 
        });
        
        items.push({
            xtype: 'textarea',
            fieldLabel: 'Query',
            name: 'parentQuery',
            anchor: '100%',
            cls: 'query-field',
            margin: '0 70 0 0',
            plugins: [
                {
                    ptype: 'rallyhelpfield',
                    helpId: 194
                },
                'rallyfieldvalidationui'
            ],
            validateOnBlur: false,
            validateOnChange: false,
            validator: function(value) {
                try {
                    if (value) {
                        Rally.data.wsapi.Filter.fromQueryString(value);
                    }
                    return true;
                } catch (e) {
                    return e.message;
                }
            }
        });
        
        return items;
    }
});